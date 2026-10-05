import { parentPort, workerData } from "maligator:workers";
import type {
	RootBatch,
	RootBatchResult,
} from "../../../src/compiler/root-compilation.ts";
const batch = workerData as RootBatch;
if (batch.jobs[0]!.index === 0)
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 30);
	});
const message = {
	results: batch.jobs.map((job) => ({
		index: job.index,
		failure: {
			kind: "error" as const,
			type: "TypeError",
			baseType: "TypeError",
			name: "TypeError",
			message: job.index === 0 ? "earlier" : "later",
			properties: {},
		},
	})),
} satisfies RootBatchResult;
parentPort!.postMessage(message);
parentPort!.close();
