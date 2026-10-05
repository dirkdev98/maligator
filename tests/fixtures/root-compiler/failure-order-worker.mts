import { parentPort, workerData } from "node:worker_threads";
import { SyntaxDiagnostic } from "../../../src/compiler/frontend/syntax-diagnostic.ts";
import { serializeRootFailure } from "../../../src/compiler/root-compilation.ts";
import type {
	RootBatch,
	RootBatchResult,
} from "../../../src/compiler/root-compilation.ts";

const batch = workerData as RootBatch;
await new Promise<void>((resolve) => {
	setTimeout(resolve, batch.jobs[0]!.index === 0 ? 120 : 0);
});
parentPort!.postMessage({
	results: batch.jobs.map((job) => ({
		index: job.index,
		failure: serializeRootFailure(
			new SyntaxDiagnostic("resolution", `root ${job.index}`, {
				cause: new TypeError(`cause ${job.index}`),
			}),
		),
	})),
} satisfies RootBatchResult);
parentPort!.close();
