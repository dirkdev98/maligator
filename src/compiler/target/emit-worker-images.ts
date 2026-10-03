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
	const lines = [
		'#include "workers.h"',
		...workers.map(
			(worker) => `extern const MalRuntimeImage mal_runtime_image_worker_${worker.id};`,
		),
	];
	if (workers.length > 0) {
		lines.push("static const MalWorkerEntry mal_compiled_worker_entries[] = {");
		for (const worker of workers)
			lines.push(
				`    { .href = "${cEscapeString(worker.entry.href)}", .image = &mal_runtime_image_worker_${worker.id}, .wire = nullptr, .wire_size = 0, .resolve_installer = nullptr },`,
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
	units.push({
		id: "worker-registry",
		kind: "data",
		source: lines.join("\n"),
		headerFiles: ["workers.h"],
		definitions: [],
	});
	return units;
}
