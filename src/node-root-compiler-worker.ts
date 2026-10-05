import { parentPort, workerData } from "node:worker_threads";
import { compileRootBatch } from "./compiler/root-compilation-kernel.ts";
import type { RootBatch } from "./compiler/root-compilation.ts";

try {
	const result = compileRootBatch(workerData as RootBatch);
	parentPort!.postMessage(result.value, result.transfers);
} finally {
	parentPort?.close();
}
