import { parentPort, workerData } from "node:worker_threads";
import { test262LoadCache } from "./cache.ts";
import {
	test262DrainStats,
	test262RunBatch,
	test262SetRuntimeArchive,
} from "./runtime.ts";
import type { Test262File } from "./types.ts";

/**
 * A compile worker owns a whole batch end to end - compose, JS->C compile, cc,
 * run, parse - on its own thread, so the otherwise single-threaded JS->C compile
 * (the run's serial bottleneck) parallelizes across cores. Only path lists and
 * small result lists cross the thread boundary: the worker loads the test corpus
 * itself (from the on-disk cache) and writes/reads the large generated C and
 * objects through the filesystem and the shared artifact cache.
 */

if (!parentPort) {
	throw new Error("compile-worker must run as a worker thread");
}
const port = parentPort;
test262SetRuntimeArchive((workerData as { runtimeArchive: string }).runtimeArchive);

// Each worker holds its own copy of the corpus, indexed by path. Loading it here
// (rather than shipping file contents per message) keeps messages tiny.
const corpus = test262LoadCache();
const filesByPath = new Map<string, Test262File>(
	corpus.files.map((file) => [file.path, file]),
);

type IncomingMessage =
	| { type: "batch"; paths: Array<string>; workerId: number }
	| { type: "drain" };

port.on("message", (message: IncomingMessage) => {
	if (message.type === "drain") {
		port.postMessage({ type: "stats", snapshot: test262DrainStats() });
		port.close();
		return;
	}

	void runBatch(message.paths, message.workerId);
});

async function runBatch(paths: Array<string>, workerId: number) {
	const files: Array<Test262File> = [];
	for (const path of paths) {
		const file = filesByPath.get(path);
		if (file) {
			// Results are mutated in place; reset before a (re)run.
			file.result = "UNKNOWN";
			files.push(file);
		}
	}

	await test262RunBatch(files, workerId);

	port.postMessage({
		type: "batchDone",
		results: files.map((file) => ({ path: file.path, result: file.result })),
		processed: paths.length,
	});
}

// Signal readiness so the main thread sends the first batch.
port.postMessage({ type: "ready" });
