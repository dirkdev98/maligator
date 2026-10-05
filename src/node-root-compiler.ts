import { Worker } from "node:worker_threads";
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

export {
	captureRootInputs,
	captureRootPackageAbsences,
	validateRootInputs,
	validateRootPackageAbsences,
} from "./compiler/root-compilation.ts";

export interface NodeRootCompilationControls extends RootCompilationControls {
	workerUrl?: URL;
}

export function startNodeRootCompilation(
	graph: ModuleGraph,
	options: CompileEntrypointOptions,
	ownerInputs: ReadonlyArray<FrontendDependencyIdentity>,
	controls: NodeRootCompilationControls,
): RootCompilation {
	return startRootCompilation(
		graph,
		options,
		ownerInputs,
		controls,
		(batch) =>
			new Promise((resolve) => {
				const receiver = rootBatchReceiver(batch);
				const worker = new Worker(
					controls.workerUrl ??
						new URL("./node-root-compiler-worker.ts", import.meta.url),
					{ workerData: batch },
				);
				worker.on("message", (value: unknown) => receiver.message(value));
				worker.on("messageerror", (error: unknown) => receiver.fail(error));
				worker.once("error", (error) => receiver.fail(error));
				worker.once("exit", (code) => resolve(receiver.joined(code)));
			}),
	);
}
