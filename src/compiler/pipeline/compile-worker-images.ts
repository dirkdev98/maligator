import { hash } from "node:crypto";
import type { ModuleGraph } from "../frontend/module-graph.ts";
import type { WorkerEntryDeclaration } from "../frontend/worker-entries.ts";
import { serializeRuntimeImage } from "../target/program-image-codec.ts";
import type { ProgramImage } from "../target/program-image.ts";
import type { CompileEntrypointOptions } from "./compile-program-common.ts";
import { compileEntrypoint } from "./compile-program.ts";

export interface CompiledWorkerImage {
	readonly id: string;
	readonly entry: WorkerEntryDeclaration;
	readonly image: ProgramImage;
	readonly wire: Uint8Array;
}

export interface DevelopmentWorkerManifest {
	readonly schema: 1;
	readonly poolEntry?: string;
	readonly entries: ReadonlyArray<{
		readonly href: string;
		readonly wirePath: string;
		readonly sha256: string;
	}>;
}

export function workerRootEntries(
	graph: Pick<ModuleGraph, "workerEntries">,
): Array<WorkerEntryDeclaration> {
	const entries = new Map<string, WorkerEntryDeclaration>();
	for (const entry of graph.workerEntries ?? []) {
		const previous = entries.get(entry.href);
		entries.set(entry.href, previous?.workerSource === undefined ? entry : previous);
	}
	return [...entries.values()];
}

export function compileWorkerImages(
	graph: Pick<ModuleGraph, "workerEntries" | "dynamicImportCandidates">,
	options: CompileEntrypointOptions = {},
): Array<CompiledWorkerImage> {
	const candidates = graph.dynamicImportCandidates ?? [];
	const workers: Array<CompiledWorkerImage> = [];
	for (const entry of workerRootEntries(graph)) {
		// A fresh lowering context gives this root its own merged module initialization.
		const image = compileEntrypoint(entry.path, {
			...options,
			entrySource: undefined,
			entryGoal: undefined,
			entryStrict: true,
			dynamicImportCandidates: candidates,
		});
		workers.push({
			id: hash("sha256", entry.href, "hex").slice(0, 20),
			entry,
			image,
			wire: serializeRuntimeImage(image.runtime),
		});
	}
	return workers;
}

export function developmentWorkerManifest(
	workers: ReadonlyArray<Pick<CompiledWorkerImage, "entry" | "wire">>,
	publishWire: (wire: Uint8Array, digest: string) => string,
): DevelopmentWorkerManifest {
	return {
		schema: 1,
		poolEntry: workers.find((worker) => worker.entry.workerSource !== undefined)?.entry
			.href,
		entries: workers.map((worker) => {
			const sha256 = hash("sha256", worker.wire, "hex");
			return {
				href: worker.entry.href,
				wirePath: publishWire(worker.wire, sha256),
				sha256,
			};
		}),
	};
}
