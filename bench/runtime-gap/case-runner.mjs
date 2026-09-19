import { performance } from "node:perf_hooks";

export function runRuntimeGapCase(id, run, verify) {
	const scale = Number(process.argv[2] ?? "1");
	if (!Number.isSafeInteger(scale) || scale < 1) {
		throw new Error("scale must be a positive integer");
	}
	const warmupBlocks = Number(process.argv[3] ?? "5");
	if (!Number.isSafeInteger(warmupBlocks) || warmupBlocks < 1 || warmupBlocks > 16) {
		throw new Error("warmup blocks must be an integer from 1 through 16");
	}
	const warmupMs = [];
	for (let warmup = 0; warmup < warmupBlocks; warmup++) {
		const warmupStartedAt = performance.now();
		run(Math.min(scale, 4));
		warmupMs.push(performance.now() - warmupStartedAt);
	}
	const allocatedReader = Reflect.get(globalThis, "__mal_gc_allocated_bytes");
	const collectionsReader = Reflect.get(globalThis, "__mal_gc_collections");
	const beforeAllocated =
		typeof allocatedReader === "function" ? allocatedReader() : undefined;
	const beforeCollections =
		typeof collectionsReader === "function" ? collectionsReader() : undefined;
	const startedAt = performance.now();
	const measured = run(scale);
	const finishedAt = performance.now();
	verify?.(measured);
	const afterAllocated =
		typeof allocatedReader === "function" ? allocatedReader() : undefined;
	const afterCollections =
		typeof collectionsReader === "function" ? collectionsReader() : undefined;
	console.log(
		JSON.stringify({
			schema: 2,
			workload: "runtime-gap-case-v2",
			id,
			scale,
			operations: measured.operations,
			checksum: measured.checksum,
			elapsedMs: finishedAt - startedAt,
			measurementStartMs: startedAt,
			measurementEndMs: finishedAt,
			warmupMs,
			...(beforeAllocated === undefined || afterAllocated === undefined
				? {}
				: { allocatedBytes: Math.max(0, afterAllocated - beforeAllocated) }),
			...(beforeCollections === undefined || afterCollections === undefined
				? {}
				: { collections: Math.max(0, afterCollections - beforeCollections) }),
		}),
	);
}
