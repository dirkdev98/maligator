import { createWorkerUrl, Worker } from "maligator:workers";
import type { WorkerUrl } from "maligator:workers";
import type { ModuleGraph } from "./compiler/frontend/module-graph.ts";
import type { CompileEntrypointOptions } from "./compiler/pipeline/compile-program-common.ts";
import {
	rootBatchReceiver,
	startRootCompilation,
} from "./compiler/root-compilation-session.ts";
import type {
	RootCompilation,
	RootCompilationControls,
} from "./compiler/root-compilation.ts";
import type { FrontendDependencyIdentity } from "./frontend-cache.ts";

export { validateRootInputs } from "./compiler/root-compilation.ts";

const rootEntry = createWorkerUrl("./native-root-compiler-worker.ts", import.meta.url);

// A product batch can carry two 27 MiB MALC/MALW pairs; all replies remain bounded.
export const ROOT_COMPILATION_MESSAGE_BYTES = 128 * 1024 * 1024;

export interface NativeRootCompilationControls extends RootCompilationControls {
	entry?: WorkerUrl;
}

export function startNativeRootCompilation(
	graph: ModuleGraph,
	options: CompileEntrypointOptions,
	ownerInputs: ReadonlyArray<FrontendDependencyIdentity>,
	controls: NativeRootCompilationControls,
): RootCompilation {
	return startRootCompilation(
		graph,
		options,
		ownerInputs,
		controls,
		(batch) =>
			new Promise((resolve) => {
				const receiver = rootBatchReceiver(batch);
				const worker = new Worker(controls.entry ?? rootEntry, {
					data: batch,
					name: "root-compiler",
					maxQueuedMessages: 2,
					maxQueuedBytes: ROOT_COMPILATION_MESSAGE_BYTES,
					maxMessageBytes: ROOT_COMPILATION_MESSAGE_BYTES,
				});
				worker.port.addEventListener("message", (event) =>
					receiver.message((event as MessageEvent<unknown>).data),
				);
				worker.port.addEventListener("messageerror", (event) =>
					receiver.fail((event as MessageEvent<unknown>).data),
				);
				worker.addEventListener("error", (event) =>
					receiver.fail((event as Event & { error: unknown }).error),
				);
				worker.port.start();
				void worker.ready.catch((error: unknown) => receiver.fail(error));
				void worker.closed.then(
					(exit) => {
						if (exit.reason !== "completed")
							receiver.fail(
								"error" in exit ? exit.error : new Error(`root worker ${exit.reason}`),
							);
						resolve(receiver.joined(exit.code));
					},
					(error: unknown) => {
						receiver.fail(error);
						resolve(receiver.joined(1));
					},
				);
			}),
	);
}
