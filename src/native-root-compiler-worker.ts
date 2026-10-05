import { parentPort, workerData } from "maligator:workers";
import { compileRootBatch } from "./compiler/root-compilation-kernel.ts";
import type { RootBatch } from "./compiler/root-compilation.ts";

try {
	const result = compileRootBatch(workerData as RootBatch);
	if (parentPort === null) throw new Error("root compiler requires a worker parent");
	parentPort.postMessage(result.value, result.transfers);
} finally {
	parentPort?.close();
}
