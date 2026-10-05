import { parentPort } from "node:worker_threads";
import { maligatorCacheDirectory } from "./cache-root.ts";
import { compilerProducerDigestsForRoot } from "./compiler-cache-identity.ts";
import { prepare } from "./compiler-service-worker.ts";
import type {
	NodeCompilationJob,
	NodeCompilationReply,
} from "./node-compiler-service.ts";

const producerDigests = compilerProducerDigestsForRoot(
	import.meta.dirname,
	maligatorCacheDirectory(),
);

parentPort!.on("message", (job: NodeCompilationJob | { close: true }) => {
	if ("close" in job) {
		parentPort!.close();
		return;
	}
	const flag = new Int32Array(job.cancellation);
	const controller = new AbortController();
	const throwIfCancelled = () => {
		if (Atomics.load(flag, 0) !== 0) controller.abort();
		controller.signal.throwIfAborted();
	};
	let reply: NodeCompilationReply;
	try {
		const value = prepare(
			{
				signal: controller.signal,
				throwIfCancelled,
				report: job.phases
					? (phase) => parentPort!.postMessage({ id: job.id, phase })
					: undefined,
			},
			{
				...job.request,
				producerDigests,
			},
		);
		throwIfCancelled();
		reply = { id: job.id, ok: true, value };
	} catch (error) {
		reply = { id: job.id, ok: false, error };
	}
	parentPort!.postMessage(reply);
});
