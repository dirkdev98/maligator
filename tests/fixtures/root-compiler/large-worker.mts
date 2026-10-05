import { parentPort, workerData } from "maligator:workers";
import type {
	RootBatch,
	RootBatchResult,
} from "../../../src/compiler/root-compilation.ts";
const batch = workerData as RootBatch;
const payload = new Uint8Array(35 * 1024 * 1024);
payload[0] = 17;
payload[payload.length - 1] = 29;
const message = {
	results: batch.jobs.map((job) => ({
		index: job.index,
		failure: {
			kind: "error" as const,
			type: "TypeError",
			baseType: "TypeError",
			name: "TypeError",
			message: "large root report",
			properties: { payload },
		},
	})),
} satisfies RootBatchResult;
if (parentPort === null) throw new Error("large root needs a parent");
parentPort.postMessage(message, [payload.buffer]);
if (payload.buffer.byteLength !== 0)
	throw new Error("root result buffer was not transferred");
parentPort.close();
