import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { Worker } from "node:worker_threads";
import { test262LoadCache, test262PersistCache } from "../src/test262/cache.ts";
import { TEST262_METADATA } from "../src/test262/constants.ts";
import {
	test262Checkout,
	test262CollectFiles,
	test262ListFiles,
} from "../src/test262/files.ts";
import { test262Log } from "../src/test262/log.ts";
import {
	getCodeStats,
	getFailuresWithSamples,
	getTimings,
	test262MergeStats,
	test262PrepareBuild,
	test262PruneArtifactCache,
	test262ResetStats,
	test262RunBatch,
} from "../src/test262/runtime.ts";
import type { StatsSnapshot } from "../src/test262/runtime.ts";
import type { Test262File, Test262Output } from "../src/test262/types.ts";

function argValue(name: string) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const random = process.argv.includes("--random");
const filter = argValue("--filter");
const jobs = Number(argValue("--jobs") ?? Math.max(1, os.cpus().length - 1));

/**
 * Run mode. No flag → strict-only: `noStrict` tests are skipped, everything else
 * runs strict (the committed scripts/test262.json baseline). `--strict dual` →
 * the full test262 spec: a strict pass (default + onlyStrict + module + raw,
 * skipping noStrict) and a sloppy pass (default + noStrict scripts), each with
 * its own artifact cache (`.cache/test262-artifacts-<variant>`) and results file
 * (scripts/test262-<variant>.json), driven through the T262_VARIANT env var
 * (which also reaches worker threads and the runtime's strictness/skip logic).
 */
const strictMode = argValue("--strict");
if (strictMode !== undefined && strictMode !== "dual") {
	throw new Error(`--strict only supports 'dual', got '${strictMode}'`);
}

/**
 * When > 0, run the JS->C compile (plus its cc/run) across this many worker
 * threads instead of the single-threaded queue. The compile is otherwise the
 * run's serial bottleneck; parallelizing it lets cc/run saturate every core.
 */
const compileWorkers = Number(
	argValue("--compile-workers") ?? process.env.T262_COMPILE_WORKERS ?? 0,
);

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
if (random) {
	selection = selection.filter(() => Math.random() < 0.05);
	test262Log(`Sampled ${selection.length} files.`);
}

// Reset per suite by runSuite() so a dual-run's two passes each time and report
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

async function worker(workerId: number, queue: Array<Array<Test262File>>) {
	while (true) {
		const batch = queue.pop();
		if (!batch) {
			return;
		}

		await test262RunBatch(batch, workerId);
		reportProgress(batch.length);
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
	if (file.result === "SKIPPED" || file.result === "UNSUPPORTED") {
		return "SKIPPED";
	}
	return "FAILED";
}

/**
 * Run the whole selection once under `variant` (undefined = the default
 * strict-only mode) and write its results to `suiteOutputFile`. A `--strict dual`
 * run calls this twice; each pass resets the run-level stats and every file's
 * result so the two passes neither share accumulators nor leak each other's
 * verdicts into the committed results.
 */
async function runSuite(
	variant: "strict" | "sloppy" | undefined,
	suiteOutputFile: string,
) {
	if (variant) {
		process.env.T262_VARIANT = variant;
		test262Log(`=== ${variant} pass ===`);
	} else {
		delete process.env.T262_VARIANT;
	}

	test262ResetStats();
	for (const file of cacheContext.files) {
		file.result = "UNKNOWN";
	}
	test262PrepareBuild();

	startedAt = Date.now();
	completed = 0;

	const batches: Array<Array<Test262File>> = [];
	for (let i = 0; i < selection.length; i += TEST262_METADATA.batchSize) {
		batches.push(selection.slice(i, i + TEST262_METADATA.batchSize));
	}

	if (compileWorkers > 0) {
		test262Log(`Compiling with ${compileWorkers} worker threads.`);
		await runWithWorkers(compileWorkers, batches);
	} else {
		const queue = [...batches].reverse();
		await Promise.all(
			Array.from({ length: Math.max(1, jobs) }, (_, workerId) => worker(workerId, queue)),
		);
	}

	// A full, unfiltered run touches every current-fingerprint cache key, so any
	// untouched entry is stale and safe to drop. Skip pruning on partial runs - they
	// would wrongly delete entries for the batches they never visited.
	if (!filter && !random) {
		test262PruneArtifactCache();
	}

	const summary = selection.reduce<Record<string, number>>((acc, file) => {
		acc[file.result] = (acc[file.result] ?? 0) + 1;
		return acc;
	}, {});

	const codeStats = getCodeStats();

	test262Log(`Took ${((Date.now() - startedAt) / 1000).toFixed(0)}s with ${jobs} jobs.`);
	test262Log(`Result:`, summary);
	test262Log(
		`Code: ${codeStats.functionCount} functions, ${codeStats.instructionCount} instructions across ${codeStats.compiledFiles} compiled files.`,
	);
	test262Log(`Timings:`, JSON.stringify(getTimings(), null, 2));
	test262Log(JSON.stringify(getFailuresWithSamples(), null, 2));

	// The console output is easy to lose; keep the full report next to the cache.
	writeFileSync(
		`${TEST262_METADATA.buildPath}/report${variant ? `-${variant}` : ""}.json`,
		JSON.stringify(
			{ summary, code: codeStats, timings: getTimings(), ...getFailuresWithSamples() },
			null,
			2,
		),
	);

	// Compare against the committed results to surface regressions, even on
	// partial runs.
	const isFullRun = !cacheContext.files.some((file) => file.result === "UNKNOWN");

	if (existsSync(suiteOutputFile)) {
		const previous = JSON.parse(readFileSync(suiteOutputFile, "utf-8")) as Test262Output;

		const regressions: Array<string> = [];
		const improvements: Array<string> = [];
		for (const file of selection) {
			const before = previous.results[file.path];
			const after = foldResult(file);
			if (before === "PASSED" && after === "FAILED") {
				regressions.push(file.path);
			} else if (before === "FAILED" && after === "PASSED") {
				improvements.push(file.path);
			}
		}

		test262Log(`Newly passing: ${improvements.length}.`);

		if (isFullRun && previous.code) {
			const fnDelta = codeStats.functionCount - previous.code.functionCount;
			const insnDelta = codeStats.instructionCount - previous.code.instructionCount;
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
		}
	}

	if (isFullRun) {
		writeFileSync(
			suiteOutputFile,
			JSON.stringify(
				{
					sha: cacheContext.sha,
					summary,
					code: {
						compiledFiles: codeStats.compiledFiles,
						functionCount: codeStats.functionCount,
						instructionCount: codeStats.instructionCount,
					},
					results: Object.fromEntries(
						cacheContext.files.map((file) => [file.path, foldResult(file)]),
					),
				} satisfies Test262Output,
				null,
				2,
			),
		);
		test262Log(`Updated results in ${suiteOutputFile}.`);
	} else {
		test262Log("Partial run, not updating the committed results.");
	}
}

if (strictMode === "dual") {
	const base = TEST262_METADATA.outputFile.replace(/\.json$/, "");
	await runSuite("strict", `${base}-strict.json`);
	await runSuite("sloppy", `${base}-sloppy.json`);
} else {
	await runSuite(undefined, TEST262_METADATA.outputFile);
}
