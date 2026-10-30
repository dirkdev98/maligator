import type { WorkerEntryDeclaration } from "../frontend/worker-entries.ts";
import type { CompiledWorkerImage } from "../pipeline/compile-worker-images.ts";
import { cEscapeString, emitProgramTranslationUnits } from "./emit-program-image.ts";
import type { EmitOptions, GeneratedTranslationUnit } from "./emit-program-image.ts";

export function emitWorkerImageTranslationUnits(
	workers: ReadonlyArray<CompiledWorkerImage>,
	options: EmitOptions = {},
): Array<GeneratedTranslationUnit> {
	const units = workers.flatMap((worker) =>
		emitProgramTranslationUnits(worker.image, {
			...options,
			symbolSuffix: `_worker_${worker.id}`,
		}).map((unit) => ({ ...unit, id: `worker-${worker.id}-${unit.id}` })),
	);
	units.push(
		emitWorkerRegistryTranslationUnit(
			workers.map((worker) => ({
				entry: worker.entry,
				imageSymbol: `mal_runtime_image_worker_${worker.id}`,
			})),
		),
	);
	return units;
}

export function emitWorkerRegistryTranslationUnit(
	workers: ReadonlyArray<{
		readonly entry: WorkerEntryDeclaration;
		readonly imageSymbol: string;
	}>,
): GeneratedTranslationUnit {
	const lines = [
		'#include "workers.h"',
		...[...new Set(workers.map((worker) => worker.imageSymbol))].map(
			(symbol) => `extern const MalRuntimeImage ${symbol};`,
		),
	];
	if (workers.length > 0) {
		lines.push("static const MalWorkerEntry mal_compiled_worker_entries[] = {");
		for (const worker of workers)
			lines.push(
				`    { .href = "${cEscapeString(worker.entry.href)}", .image = &${worker.imageSymbol}, .wire = nullptr, .wire_size = 0, .resolve_installer = nullptr },`,
			);
		lines.push("};");
	}
	const poolEntry = workers.find((worker) => worker.entry.workerSource !== undefined);
	lines.push(
		"void mal_register_compiled_worker_entries(void) {",
		workers.length > 0
			? `    mal_workers_register_entries(mal_compiled_worker_entries, ${workers.length});`
			: "    (void) 0;",
		...(poolEntry === undefined
			? []
			: [`    mal_workers_set_pool_entry("${cEscapeString(poolEntry.entry.href)}");`]),
		"}",
		"",
	);
	const source = lines.join("\n");
	return {
		id: "worker-registry",
		kind: "data",
		sourceChunks: [source],
		sourceCodeUnits: source.length,
		headerFiles: ["workers.h"],
		definitions: [],
	};
}
