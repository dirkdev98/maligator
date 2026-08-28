import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { Worker } from "node:worker_threads";
import { CommandProgress } from "../src/command-progress.ts";
import { test262LoadCache, test262PersistCache } from "../src/test262/cache.ts";
import { TEST262_METADATA } from "../src/test262/constants.ts";
import {
	test262Checkout,
	test262CollectFiles,
	test262ListFiles,
} from "../src/test262/files.ts";
import { test262Log } from "../src/test262/log.ts";
import {
	parseTest262Policy,
	resolveTest262ObjectCache,
	test262BatchRegressions,
	test262FoldedRegressions,
	test262WorkerCount,
} from "../src/test262/policy.ts";
import type { Test262Variant } from "../src/test262/policy.ts";
import {
	getCodeStats,
	getBatchReports,
	getFailuresWithSamples,
	getTimings,
	test262MergeStats,
	test262NativeBuildInputs,
	test262PrepareBuild,
	test262PruneArtifactCache,
	test262ReportPath,
	test262ResetStats,
} from "../src/test262/runtime.ts";
import type { StatsSnapshot } from "../src/test262/runtime.ts";
import {
	mergeTest262Manifests,
	parseTest262Manifest,
	selectTest262ManifestFiles,
} from "../src/test262/selection.ts";
import type { Test262File, Test262Output } from "../src/test262/types.ts";
import { reexecWithCleanTestEnvironment } from "./test-environment.ts";

interface Test262Arguments {
	backend?: string;
	canonical: boolean;
	check: boolean;
	excludeManifests: Array<string>;
	filter?: string;
	manifests: Array<string>;
	mode?: string;
	policy?: string;
	random: boolean;
	variant?: string;
}

const usage = `usage: node scripts/test262.ts [options]

Options:
  --canonical                  scrub ambient test dimensions
  --backend compiled|interpreted|wire
  --mode normal|gc-stress
  --manifest <file>            include listed paths; repeat to union manifests
  --exclude-manifest <file>    omit listed paths; repeat to union manifests
  --filter <substring>         run matching test paths
  --variant strict|sloppy      run one language variant for diagnostics
  --check                      compare without updating the baseline
  --policy bail|complete       stop on a regression or complete the selection
  --random                     run a non-baseline random sample
  -h, --help                   show this help`;

function parseArguments(): Test262Arguments {
	const result: Test262Arguments = {
		canonical: false,
		check: false,
		excludeManifests: [],
		manifests: [],
		random: false,
	};
	const seen = new Set<string>();
	for (let index = 2; index < process.argv.length; index++) {
		const option = process.argv[index]!;
		if (option === "-h" || option === "--help") {
			console.log(usage);
			process.exit(0);
		}
		const repeatable = option === "--manifest" || option === "--exclude-manifest";
		if (!repeatable && seen.has(option)) {
			throw new Error(`${option} may only be specified once`);
		}
		seen.add(option);
		if (option === "--canonical") result.canonical = true;
		else if (option === "--check") result.check = true;
		else if (option === "--random") result.random = true;
		else {
			const value = process.argv[++index];
			if (value === undefined || value.startsWith("--")) {
				throw new Error(`${option} requires a value\n${usage}`);
			}
			if (option === "--backend") result.backend = value;
			else if (option === "--mode") result.mode = value;
			else if (option === "--manifest") result.manifests.push(value);
			else if (option === "--exclude-manifest") result.excludeManifests.push(value);
			else if (option === "--filter") result.filter = value;
			else if (option === "--variant") result.variant = value;
			else if (option === "--policy") result.policy = value;
			else throw new Error(`unknown option: ${option}\n${usage}`);
		}
	}
	return result;
}

const arguments_ = parseArguments();
const requestedBackend = arguments_.backend ?? "compiled";
if (
	requestedBackend !== "compiled" &&
	requestedBackend !== "interpreted" &&
	requestedBackend !== "wire"
) {
	throw new Error(`--backend only supports 'compiled', 'interpreted', or 'wire'`);
}
const requestedMode = arguments_.mode ?? "normal";
if (requestedMode !== "normal" && requestedMode !== "gc-stress") {
	throw new Error(`--mode only supports 'normal' or 'gc-stress'`);
}
if (
	arguments_.canonical ||
	arguments_.backend !== undefined ||
	arguments_.mode !== undefined
) {
	const tuning = Object.fromEntries(
		["T262_COMPILE_WORKERS", "T262_OBJCACHE"].flatMap((name) => {
			const value = process.env[name];
			return value === undefined ? [] : [[name, value]];
		}),
	);
	reexecWithCleanTestEnvironment("TEST262_CANONICAL_CHILD", {
		...tuning,
		...(requestedBackend === "interpreted" ? { MAL_INTERP: "1" } : {}),
		...(requestedBackend === "wire" ? { T262_WIRE: "1" } : {}),
		...(requestedMode === "gc-stress" ? { MAL_GC_STRESS: "1", MAL_GC_VERIFY: "1" } : {}),
	});
}

const random = arguments_.random;
// Gate mode never rewrites the committed results and exits non-zero if a
// previously passing test no longer passes.
const checkMode = arguments_.check;
const policy = parseTest262Policy(arguments_.policy);
if (policy === "bail" && !checkMode) {
	throw new Error("--policy bail requires --check");
}
const filter = arguments_.filter;
// Manifest/filter runs are partial: they never rewrite committed results or
// prune artifacts for corpus entries they did not visit.
const manifestPaths = arguments_.manifests;
const excludeManifestPaths = arguments_.excludeManifests;
/** Each backend executes strict and sloppy passes. `--variant` selects one pass. */
const onlyVariant = arguments_.variant;
if (onlyVariant !== undefined && onlyVariant !== "strict" && onlyVariant !== "sloppy") {
	throw new Error(`--variant only supports 'strict' or 'sloppy', got '${onlyVariant}'`);
}

const configuredCompileWorkers = Number(
	process.env.T262_COMPILE_WORKERS ?? TEST262_METADATA.compileWorkers,
);
if (!Number.isInteger(configuredCompileWorkers) || configuredCompileWorkers < 1) {
	throw new Error("T262_COMPILE_WORKERS must be a positive integer");
}
const compileWorkers = Math.max(
	1,
	Math.min(configuredCompileWorkers, os.availableParallelism()),
);
const progress = new CommandProgress("test262");
progress.start(`${requestedBackend}/${requestedMode} · ${policy} policy`);
progress.stage(1, 3, "prepare pinned corpus");
const previousOutput = existsSync(TEST262_METADATA.outputFile)
	? (JSON.parse(readFileSync(TEST262_METADATA.outputFile, "utf-8")) as Test262Output)
	: undefined;
if (checkMode && previousOutput === undefined) {
	throw new Error(`Test262 check requires ${TEST262_METADATA.outputFile}`);
}
if (
	previousOutput?.sha !== undefined &&
	previousOutput.sha !== TEST262_METADATA.revision
) {
	const message = `Test262 baseline is ${previousOutput.sha}; pinned corpus is ${TEST262_METADATA.revision}`;
	if (checkMode) throw new Error(message);
	test262Log(`${message}. A full baseline-update run must replace it.`);
}

const checkoutSha = test262Checkout();
const fileList = test262ListFiles();
const cacheContext = test262LoadCache(fileList);
if (!cacheContext.files.length) {
	cacheContext.sha = checkoutSha;

	cacheContext.files = await test262CollectFiles(fileList);
	test262PersistCache(cacheContext);
}
progress.stagePassed(1, 3, "prepare pinned corpus", checkoutSha.slice(0, 12));

let selection = cacheContext.files;
const includeManifest =
	manifestPaths.length > 0
		? mergeTest262Manifests(
				manifestPaths.map((manifestPath) =>
					parseTest262Manifest(readFileSync(manifestPath, "utf-8")),
				),
			)
		: undefined;
const excludeManifest =
	excludeManifestPaths.length > 0
		? mergeTest262Manifests(
				excludeManifestPaths.map((manifestPath) =>
					parseTest262Manifest(readFileSync(manifestPath, "utf-8")),
				),
			)
		: undefined;
selection = selectTest262ManifestFiles(selection, includeManifest, excludeManifest);
if (filter) {
	selection = selection.filter((file) => file.path.includes(filter));
	test262Log(`Filtered to ${selection.length} files matching '${filter}'.`);
}
if (manifestPaths.length > 0) {
	test262Log(
		`Manifest${manifestPaths.length === 1 ? "" : "s"} ${manifestPaths.map((manifestPath) => nodePath.basename(manifestPath)).join(", ")}: ${selection.length}/${includeManifest?.size ?? 0} files.`,
	);
}
if (excludeManifestPaths.length > 0) {
	test262Log(
		`Excluded ${excludeManifest?.size ?? 0} files from ${excludeManifestPaths.map((manifestPath) => nodePath.basename(manifestPath)).join(", ")}; ${selection.length} remain.`,
	);
}
if (random) {
	selection = selection.filter(() => Math.random() < 0.05);
	test262Log(`Sampled ${selection.length} files.`);
}
if (selection.length === 0) {
	throw new Error("Test262 selection is empty");
}

// A manifest/filter/random run is partial: it must not rewrite the committed
// results or prune the artifact cache (it never visits every key).
const isPartialRun =
	Boolean(filter) ||
	manifestPaths.length > 0 ||
	excludeManifestPaths.length > 0 ||
	random;
const explicitObjectCache = process.env.T262_OBJCACHE;
process.env.T262_OBJCACHE = resolveTest262ObjectCache(explicitObjectCache, isPartialRun);
if (!isPartialRun && explicitObjectCache === undefined) {
	test262Log(
		"Full corpus: compiled-object cache disabled by default to bound disk use; set T262_OBJCACHE=1 to retain it.",
	);
}
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
let activeVariant: Test262Variant = "strict";
let lastProgressBucket = -1;

function reportProgress(processed: number) {
	completed += processed;
	const bucket = Math.min(20, Math.floor((completed * 20) / selection.length));
	if (bucket > lastProgressBucket || completed === selection.length) {
		lastProgressBucket = bucket;
		progress.progress(completed, selection.length, `${activeVariant} tests`);
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
	variant: Test262Variant,
): Promise<{ aborted: boolean; regressions: Array<string> }> {
	const filesByPath = new Map(selection.map((file) => [file.path, file]));
	let nextBatch = 0;
	let aborted = false;
	const regressions: Array<string> = [];
	const previous = previousOutput?.results ?? {};

	const workerUrl = new URL("../src/test262/compile-worker.ts", import.meta.url);

	await Promise.all(
		Array.from(
			{ length: workerCount },
			(_unused, workerId) =>
				new Promise<void>((resolve, reject) => {
					const thread = new Worker(workerUrl, {
						workerData: { nativeBuildInputs: test262NativeBuildInputs() },
					});

					const sendNext = () => {
						if (!aborted && nextBatch < allBatches.length) {
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
								if (policy === "bail" && checkMode) {
									const batchRegressions = test262BatchRegressions(
										message.results,
										filesByPath,
										previous,
										variant,
									);
									if (batchRegressions.length > 0) {
										regressions.push(...batchRegressions);
										aborted = true;
									}
								}
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
	return { aborted, regressions };
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
	aborted: boolean;
	regressions: Array<string>;
}

/**
 * Run the whole selection once under `variant`. Each pass resets the run-level
 * stats and every file's result so the two passes neither share accumulators nor
 * leak each other's verdicts, logs this pass's summary/timings/failures, and dumps
 * the full granular report next to the cache (uncommitted). Returns the folded
 * per-file verdicts and code totals for {@link combineRuns} to merge.
 */
async function runVariant(variant: Test262Variant): Promise<VariantRun> {
	activeVariant = variant;
	process.env.T262_VARIANT = variant;
	test262Log(`=== ${variant} pass ===`);

	test262ResetStats();
	for (const file of cacheContext.files) {
		file.result = "UNKNOWN";
	}
	startedAt = Date.now();
	completed = 0;
	lastProgressBucket = -1;
	const batches: Array<Array<Test262File>> = [];
	for (let i = 0; i < selection.length; i += batchSize) {
		batches.push(selection.slice(i, i + batchSize));
	}
	const workerCount = test262WorkerCount(compileWorkers, batches.length);
	test262Log(
		requestedBackend === "wire"
			? `Throughput: batch ${batchSize}, ${workerCount} compile workers, cached MalW, shared runtime, full IR.`
			: `Throughput: batch ${batchSize}, ${workerCount} compile workers, generated C -O0, runtime -O2, full IR, LTO off.`,
	);

	const run = await runWithWorkers(workerCount, batches, variant);

	// A full, unfiltered run touches every current-fingerprint cache key, so any
	// untouched entry is stale and safe to drop. Skip pruning on partial runs - they
	// would wrongly delete entries for the batches they never visited.
	if (!isPartialRun && !run.aborted) {
		test262PruneArtifactCache();
	}

	const summary = selection.reduce<Record<string, number>>((acc, file) => {
		acc[file.result] = (acc[file.result] ?? 0) + 1;
		return acc;
	}, {});

	const codeStats = getCodeStats();

	test262Log(
		`Took ${((Date.now() - startedAt) / 1000).toFixed(0)}s with ${workerCount} compile workers.`,
	);
	if (run.aborted) {
		test262Log(
			`Bail policy: aborted after ${completed}/${selection.length} tests; ${run.regressions.length} regression(s) found.`,
		);
	}
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
			{
				schemaVersion: 2,
				variant,
				complete: !run.aborted,
				aborted: run.aborted,
				processedTests: completed,
				totalTests: selection.length,
				regressions: run.regressions,
				summary,
				code: codeStats,
				timings: getTimings(),
				...getFailuresWithSamples(),
				batches: getBatchReports(),
			},
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
		aborted: run.aborted,
		regressions: run.regressions,
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
	let regressions: Array<string> = [];
	const improvements: Array<string> = [];
	// Compare against the committed results to surface regressions, even on
	// partial runs.
	if (previousOutput) {
		const previous = previousOutput;
		regressions = test262FoldedRegressions(combined, previous.results);
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
			if (checkMode) {
				process.exitCode = 1;
			}
		}
	}

	writeFileSync(
		test262ReportPath("combined"),
		JSON.stringify(
			{
				schemaVersion: 1,
				backend: requestedBackend,
				mode: process.env.MAL_GC_STRESS ? "gc-stress" : "normal",
				policy,
				complete: true,
				selectedTests: selection.length,
				summary,
				code,
				regressions,
				improvements,
			},
			null,
			2,
		),
	);

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

// Build once per invocation. Reusing the harness objects across the strict and
// sloppy passes also prevents the second pass from deleting the first report.
progress.stage(2, 3, "prepare standard runtime");
test262PrepareBuild();
progress.stagePassed(2, 3, "prepare standard runtime");
progress.stage(
	3,
	3,
	onlyVariant === undefined ? "run strict and sloppy passes" : `run ${onlyVariant} pass`,
);

if (onlyVariant) {
	// Single-pass debug run: report only, never touch the committed results.
	const run = await runVariant(onlyVariant);
	if (run.aborted) {
		process.exitCode = 1;
	}
} else {
	const strict = await runVariant("strict");
	if (strict.aborted) {
		process.exitCode = 1;
	} else {
		const sloppy = await runVariant("sloppy");
		if (sloppy.aborted) {
			process.exitCode = 1;
		} else {
			combineRuns(strict, sloppy);
		}
	}
}
if (process.exitCode === undefined || process.exitCode === 0) {
	progress.stagePassed(
		3,
		3,
		onlyVariant === undefined
			? "run strict and sloppy passes"
			: `run ${onlyVariant} pass`,
	);
	progress.complete();
} else {
	progress.stageFailed(
		3,
		3,
		onlyVariant === undefined
			? "run strict and sloppy passes"
			: `run ${onlyVariant} pass`,
	);
	progress.failed();
}
