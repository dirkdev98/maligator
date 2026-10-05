import { parentPort, workerData } from "maligator:workers";
import type {
	RootBatch,
	RootBatchResult,
} from "../../../src/compiler/root-compilation.ts";
const batch = workerData as RootBatch;
const flag = new Int32Array(batch.cancellation);
while (Atomics.load(flag, 0) === 0)
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 1);
	});
parentPort!.postMessage({
	results: batch.jobs.map((job) => ({
		index: job.index,
		failure: { kind: "value" as const, value: null },
	})),
} satisfies RootBatchResult);
parentPort!.close();
