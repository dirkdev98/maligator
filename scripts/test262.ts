import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { Worker } from "node:worker_threads";
import { test262LoadCache, test262PersistCache } from "../src/test262/cache.ts";
import { TEST262_METADATA } from "../src/test262/constants.ts";
import {
	test262Checkout,
	test262CollectFiles,
	test262ListFiles,
} from "../src/test262/files.ts";
import { test262Log } from "../src/test262/log.ts";
import { summarizeTest262Preflight } from "../src/test262/preflight.ts";
import type { Test262PreflightSummary } from "../src/test262/preflight.ts";
import {
	getCodeStats,
	getFailuresWithSamples,
	getTimings,
	test262MergeStats,
	test262PrepareBuild,
	test262PruneArtifactCache,
	test262ReportPath,
	test262ResetStats,
} from "../src/test262/runtime.ts";
import type { StatsSnapshot } from "../src/test262/runtime.ts";
import type { Test262File, Test262Output } from "../src/test262/types.ts";

function argValue(name: string) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const random = process.argv.includes("--random");
// Gate mode: never rewrite the committed results, and exit non-zero if any test
// regressed (PASSED -> FAILED) against them. Used by scripts/gate.ts to run the
// suite in several modes (compiled / --no-compiled / STRESS) without one mode's
// flaky verdicts clobbering the committed baseline.
const checkMode = process.argv.includes("--check");
const filter = argValue("--filter");
// Restrict the run to an explicit newline-separated list of test paths (the
// committed regression manifest). Like --filter, it is a partial run: it never
// rewrites the committed results and does not prune the artifact cache.
const manifestPath = argValue("--manifest");
/**
 * A full invocation first runs an interpreted preflight, then starts the
 * authoritative compiled backend unless more than 5% of non-skipped tests
 * regressed against the committed baseline. Each backend executes the spec as a
 * strict pass (default + onlyStrict + module + raw, skipping noStrict) and a
 * sloppy pass (default + noStrict scripts), each with its own artifact cache
 * namespace per backend/variant, driven through the T262_VARIANT env var (which
 * also reaches worker threads and the runtime's strictness/skip logic). The two
 * passes are folded per test - spec-compliant: a "default" test runs in both
 * modes and passes only if it passes in each - into the single committed
 * scripts/test262.json (see {@link combineRuns}).
 *
 * `--variant strict|sloppy` runs just that one pass for debugging: it logs and
 * dumps a per-pass report but never rewrites the committed results.
 */
const onlyVariant = argValue("--variant");
if (onlyVariant !== undefined && onlyVariant !== "strict" && onlyVariant !== "sloppy") {
	throw new Error(`--variant only supports 'strict' or 'sloppy', got '${onlyVariant}'`);
}

const compileWorkers = Math.max(
	1,
	Math.min(TEST262_METADATA.compileWorkers, os.availableParallelism()),
);
const preflightMode = process.env.T262_PREFLIGHT === "1";
const isFullRunRequest = !filter && !manifestPath && !random && !onlyVariant;
const preflightPath = TEST262_METADATA.preflightFile;

if (isFullRunRequest && process.env.T262_ORCHESTRATED !== "1") {
	const entrypoint = process.argv[1];
	if (!entrypoint) {
		throw new Error("Unable to resolve the Test262 runner entrypoint");
	}
	const args = [entrypoint, ...process.argv.slice(2)];
	rmSync(preflightPath, { force: true });

	test262Log("=== backend: interpreted preflight ===");
	const interpreted = spawnSync(process.execPath, args, {
		stdio: "inherit",
		env: {
			...process.env,
			MAL_INTERP: "1",
			T262_ORCHESTRATED: "1",
			T262_PREFLIGHT: "1",
		},
	});
	if (interpreted.status !== 0 || !existsSync(preflightPath)) {
		test262Log("Interpreted preflight did not complete; skipping compiled mode.");
		process.exit(interpreted.status ?? 1);
	}

	const preflight = JSON.parse(
		readFileSync(preflightPath, "utf8"),
	) as Test262PreflightSummary;
	if (preflight.abortCompiled) {
		test262Log(
			`Interpreted preflight regressed ${preflight.regressions.length}/${preflight.ranTests} tests (${(preflight.regressionRate * 100).toFixed(2)}%); limit is ${(TEST262_METADATA.preflightRegressionLimit * 100).toFixed(0)}%. Skipping compiled mode.`,
		);
		process.exit(1);
	}

	test262Log(
		`Interpreted preflight regressed ${preflight.regressions.length}/${preflight.ranTests} tests (${(preflight.regressionRate * 100).toFixed(2)}%); continuing to compiled mode.`,
	);
	test262Log("=== backend: compiled ===");
	const compiled = spawnSync(process.execPath, args, {
		stdio: "inherit",
		env: {
			...process.env,
			MAL_INTERP: "0",
			T262_ORCHESTRATED: "1",
			T262_PREFLIGHT: "0",
		},
	});
	process.exit(compiled.status ?? 1);
}

const cacheContext = test262LoadCache();

if (!cacheContext.files.length) {
	cacheContext.sha = test262Checkout();

	const fileIterator = test262ListFiles();
	cacheContext.files = await test262CollectFiles(fileIterator);
	test262PersistCache(cacheContext);
}

let selection = cacheContext.files;
if (filter) {
	selection = selection.filter((file) => file.path.includes(filter));
	test262Log(`Filtered to ${selection.length} files matching '${filter}'.`);
}
if (manifestPath) {
	const wanted = new Set(
		readFileSync(manifestPath, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#")),
	);
	selection = selection.filter((file) => wanted.has(file.path));
	const missing = wanted.size - selection.length;
	test262Log(
		`Manifest ${nodePath.basename(manifestPath)}: ${selection.length}/${wanted.size} files${
			missing > 0 ? ` (${missing} not in corpus)` : ""
		}`,
	);
}
if (random) {
	selection = selection.filter(() => Math.random() < 0.05);
	test262Log(`Sampled ${selection.length} files.`);
}

// A manifest/filter/random run is partial: it must not rewrite the committed
// results or prune the artifact cache (it never visits every key).
const isPartialRun = Boolean(filter) || Boolean(manifestPath) || random;
const batchSize = isPartialRun
	? Math.min(
			TEST262_METADATA.batchSize,
			Math.max(
				TEST262_METADATA.minimumBatchSize,
				Math.ceil(
					selection.length / (compileWorkers * TEST262_METADATA.targetBatchesPerWorker),
				),
			),
		)
	: TEST262_METADATA.batchSize;

// Reset per pass by runVariant() so the two passes time and report
// independently; the worker/progress closures below read these live.
let startedAt = 0;
let completed = 0;

function reportProgress(processed: number) {
	const previous = completed;
	completed += processed;
	if (Math.floor(completed / 2500) > Math.floor(previous / 2500)) {
		const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
		test262Log(`Progress: ${completed} / ${selection.length} (${elapsed}s)`);
	}
}

/**
 * Drive the batch queue across worker threads. Each worker pulls the next batch
 * (work-stealing - `nextBatch` is bumped on the single main-thread event loop, so
 * no lock is needed), runs it to completion, and reports back; on drain it ships
 * its accumulated stats for merging into the main report.
 */
async function runWithWorkers(
	workerCount: number,
	allBatches: Array<Array<Test262File>>,
) {
	const filesByPath = new Map(selection.map((file) => [file.path, file]));
	let nextBatch = 0;

	const workerUrl = new URL("../src/test262/compile-worker.ts", import.meta.url);

	await Promise.all(
		Array.from(
			{ length: workerCount },
			(_unused, workerId) =>
				new Promise<void>((resolve, reject) => {
					const thread = new Worker(workerUrl);

					const sendNext = () => {
						if (nextBatch < allBatches.length) {
							const batch = allBatches[nextBatch++]!;
							thread.postMessage({
								type: "batch",
								paths: batch.map((file) => file.path),
								workerId,
							});
						} else {
							thread.postMessage({ type: "drain" });
						}
					};

					thread.on(
						"message",
						(
							message:
								| { type: "ready" }
								| {
										type: "batchDone";
										results: Array<{ path: string; result: Test262File["result"] }>;
										processed: number;
								  }
								| { type: "stats"; snapshot: StatsSnapshot },
						) => {
							if (message.type === "ready") {
								sendNext();
							} else if (message.type === "batchDone") {
								for (const { path, result } of message.results) {
									const file = filesByPath.get(path);
									if (file) {
										file.result = result;
									}
								}
								reportProgress(message.processed);
								sendNext();
							} else {
								test262MergeStats(message.snapshot);
								void thread.terminate().then(() => resolve());
							}
						},
					);
					thread.on("error", reject);
				}),
		),
	);
}

/**
 * Fold the detailed categories for the committed results file.
 */
function foldResult(file: Test262File): "PASSED" | "SKIPPED" | "FAILED" {
	if (file.result === "PASSED") {
		return "PASSED";
	}
	if (file.result === "SKIPPED") {
		return "SKIPPED";
	}
	return "FAILED";
}

type Folded = "PASSED" | "SKIPPED" | "FAILED";

/**
 * Spec-compliant per-file fold of two passes. A "default" test (no
 * onlyStrict/noStrict/module/raw flag) runs in BOTH strict and sloppy mode and
 * passes only if it passes in each; a pass that does not run a file reports it
 * SKIPPED. Ranking SKIPPED < PASSED < FAILED and keeping the worse verdict gives
 * exactly that: any FAILED → FAILED, else any PASSED → PASSED, else SKIPPED.
 */
const FOLD_RANK: Record<Folded, number> = { SKIPPED: 0, PASSED: 1, FAILED: 2 };

function combineFolded(a: Folded, b: Folded): Folded {
	return FOLD_RANK[a] >= FOLD_RANK[b] ? a : b;
}

interface VariantRun {
	/** Folded verdict per selected test path. */
	results: Map<string, Folded>;
	code: { compiledFiles: number; functionCount: number; instructionCount: number };
}

/**
 * Run the whole selection once under `variant`. Each pass resets the run-level
 * stats and every file's result so the two passes neither share accumulators nor
 * leak each other's verdicts, logs this pass's summary/timings/failures, and dumps
 * the full granular report next to the cache (uncommitted). Returns the folded
 * per-file verdicts and code totals for {@link combineRuns} to merge.
 */
async function runVariant(variant: "strict" | "sloppy"): Promise<VariantRun> {
	process.env.T262_VARIANT = variant;
	test262Log(`=== ${variant} pass ===`);

	test262ResetStats();
	for (const file of cacheContext.files) {
		file.result = "UNKNOWN";
	}
	test262PrepareBuild();

	startedAt = Date.now();
	completed = 0;
	test262Log(
		`Throughput: batch ${batchSize}, ${compileWorkers} compile workers, generated C -O0, runtime -O2, full IR, LTO off.`,
	);

	const batches: Array<Array<Test262File>> = [];
	for (let i = 0; i < selection.length; i += batchSize) {
		batches.push(selection.slice(i, i + batchSize));
	}

	await runWithWorkers(compileWorkers, batches);

	// A full, unfiltered run touches every current-fingerprint cache key, so any
	// untouched entry is stale and safe to drop. Skip pruning on partial runs - they
	// would wrongly delete entries for the batches they never visited.
	if (!isPartialRun) {
		test262PruneArtifactCache();
	}

	const summary = selection.reduce<Record<string, number>>((acc, file) => {
		acc[file.result] = (acc[file.result] ?? 0) + 1;
		return acc;
	}, {});

	const codeStats = getCodeStats();

	test262Log(
		`Took ${((Date.now() - startedAt) / 1000).toFixed(0)}s with ${compileWorkers} compile workers.`,
	);
	test262Log(`Result:`, summary);
	test262Log(
		`Code: ${codeStats.functionCount} functions, ${codeStats.instructionCount} instructions across ${codeStats.compiledFiles} compiled files.`,
	);
	test262Log(`Timings:`, JSON.stringify(getTimings(), null, 2));
	test262Log(JSON.stringify(getFailuresWithSamples(), null, 2));

	// The console output is easy to lose; keep the full granular report (all raw
	// categories, timings, failure buckets) next to the cache. Not committed.
	writeFileSync(
		test262ReportPath(variant),
		JSON.stringify(
			{ summary, code: codeStats, timings: getTimings(), ...getFailuresWithSamples() },
			null,
			2,
		),
	);

	return {
		results: new Map(selection.map((file) => [file.path, foldResult(file)])),
		code: {
			compiledFiles: codeStats.compiledFiles,
			functionCount: codeStats.functionCount,
			instructionCount: codeStats.instructionCount,
		},
	};
}

/**
 * Fold the strict and sloppy passes into the single committed results file. Each
 * file's verdict is the spec-compliant combination of the modes it runs in (see
 * {@link combineFolded}); code-size totals sum both passes because a default test
 * genuinely compiles once per mode. Surfaces regressions/improvements against the
 * previously committed file, and only rewrites it on a full run.
 */
function combineRuns(strict: VariantRun, sloppy: VariantRun) {
	const combined = new Map<string, Folded>();
	for (const file of selection) {
		const strictResult = strict.results.get(file.path) ?? "SKIPPED";
		const sloppyResult = sloppy.results.get(file.path) ?? "SKIPPED";
		combined.set(file.path, combineFolded(strictResult, sloppyResult));
	}

	const summary = [...combined.values()].reduce<Record<string, number>>((acc, result) => {
		acc[result] = (acc[result] ?? 0) + 1;
		return acc;
	}, {});

	const code = {
		compiledFiles: strict.code.compiledFiles + sloppy.code.compiledFiles,
		functionCount: strict.code.functionCount + sloppy.code.functionCount,
		instructionCount: strict.code.instructionCount + sloppy.code.instructionCount,
	};

	test262Log(`=== combined ===`);
	test262Log(`Result:`, summary);

	const outputFile = TEST262_METADATA.outputFile;
	const isFullRun = !isPartialRun;
	let preflightSummary: Test262PreflightSummary | undefined;

	// Compare against the committed results to surface regressions, even on
	// partial runs.
	if (existsSync(outputFile)) {
		const previous = JSON.parse(readFileSync(outputFile, "utf-8")) as Test262Output;

		preflightSummary = summarizeTest262Preflight(
			combined,
			previous.results,
			TEST262_METADATA.preflightRegressionLimit,
		);
		const regressions = preflightSummary.regressions;
		const improvements: Array<string> = [];
		for (const file of selection) {
			const before = previous.results[file.path];
			const after = combined.get(file.path);
			if (before === "FAILED" && after === "PASSED") {
				improvements.push(file.path);
			}
		}

		test262Log(`Newly passing: ${improvements.length}.`);

		if (isFullRun && previous.code) {
			const fnDelta = code.functionCount - previous.code.functionCount;
			const insnDelta = code.instructionCount - previous.code.instructionCount;
			const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
			test262Log(
				`Code delta vs committed: ${sign(fnDelta)} functions, ${sign(insnDelta)} instructions.`,
			);
		}

		if (regressions.length > 0) {
			test262Log(`REGRESSIONS (${regressions.length}):`);
			for (const path of regressions.slice(0, 50)) {
				test262Log(`  ${path}`);
			}
			// Gate mode surfaces a regression as a non-zero exit so a wrapper can
			// fail the build. (Mind the known async/dynamic-import flakiness floor —
			// see scripts/gate.ts.)
			if (checkMode && !preflightMode) {
				process.exitCode = 1;
			}
		}
	}

	if (preflightMode) {
		preflightSummary ??= summarizeTest262Preflight(
			combined,
			{},
			TEST262_METADATA.preflightRegressionLimit,
		);
		writeFileSync(preflightPath, JSON.stringify(preflightSummary, null, 2));
		test262Log(
			`Preflight: ${preflightSummary.regressions.length}/${preflightSummary.ranTests} regressions (${(preflightSummary.regressionRate * 100).toFixed(2)}%).`,
		);
		return;
	}

	if (checkMode) {
		test262Log("Check mode: not updating the committed results.");
		return;
	}

	if (!isFullRun) {
		test262Log("Partial run, not updating the committed results.");
		return;
	}

	writeFileSync(
		outputFile,
		JSON.stringify(
			{
				sha: cacheContext.sha,
				summary,
				code,
				results: Object.fromEntries(combined),
			} satisfies Test262Output,
			null,
			2,
		),
	);
	test262Log(`Updated results in ${outputFile}.`);
}

if (onlyVariant) {
	// Single-pass debug run: report only, never touch the committed results.
	await runVariant(onlyVariant);
} else {
	const strict = await runVariant("strict");
	const sloppy = await runVariant("sloppy");
	combineRuns(strict, sloppy);
}
