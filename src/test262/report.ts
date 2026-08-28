import { createHash } from "node:crypto";
import type { BatchManifest } from "./artifact-cache.ts";

export type Test262BatchCacheState = "hit" | "miss" | "disabled";

export interface Test262BatchPhaseTimings {
	compileMs: number | null;
	ccMs: number | null;
	linkMs: number | null;
	runMs: number | null;
}

export interface Test262BatchReport {
	id: string;
	paths: Array<string>;
	generatedCBytes: number | null;
	logical: {
		compiledFiles: number;
		functionCount: number;
		instructionCount: number;
	};
	physical: {
		imageCount: number;
		sharedHelperCount: number;
		functionCount: number;
		instructionCount: number;
	};
	objectBytes: number | null;
	cache: Test262BatchCacheState;
	ccFailureArtifact: string | null;
	worker: number;
	timings: Test262BatchPhaseTimings;
}

/** Stable across worker scheduling and compiler revisions while membership is unchanged. */
export function test262BatchId(paths: Array<string>): string {
	const hash = createHash("sha256");
	hash.update("test262-report-batch-v1\n");
	for (const path of paths) {
		hash.update(String(Buffer.byteLength(path)));
		hash.update(":");
		hash.update(path);
		hash.update("\n");
	}
	return `batch-${hash.digest("hex")}`;
}

/** Stable filename component for a partial selection, independent of scheduling. */
export function test262SelectionId(paths: Array<string>): string {
	const hash = createHash("sha256");
	hash.update("test262-report-selection-v1\n");
	for (const path of [...paths].sort()) {
		hash.update(String(Buffer.byteLength(path)));
		hash.update(":");
		hash.update(path);
		hash.update("\n");
	}
	return `selection-${hash.digest("hex").slice(0, 16)}`;
}

function roundedMs(value: number | null): number | null {
	return value === null ? null : Math.round(value * 1000) / 1000;
}

export function createTest262BatchReport(input: {
	paths: Array<string>;
	manifest: BatchManifest;
	objectBytes: number | null;
	cache: Test262BatchCacheState;
	ccFailureArtifact?: string | null;
	worker: number;
	timings: Test262BatchPhaseTimings;
}): Test262BatchReport {
	return {
		id: test262BatchId(input.paths),
		paths: [...input.paths],
		generatedCBytes: input.manifest.generatedCBytes,
		logical: {
			compiledFiles: input.manifest.stats.compiledFiles,
			functionCount: input.manifest.stats.functionCount,
			instructionCount: input.manifest.stats.instructionCount,
		},
		physical: {
			imageCount: input.manifest.physical.imageCount,
			sharedHelperCount: input.manifest.physical.sharedHelperCount,
			functionCount: input.manifest.physical.functionCount,
			instructionCount: input.manifest.physical.instructionCount,
		},
		objectBytes: input.objectBytes,
		cache: input.cache,
		ccFailureArtifact: input.ccFailureArtifact ?? null,
		worker: input.worker,
		timings: {
			compileMs: roundedMs(input.timings.compileMs),
			ccMs: roundedMs(input.timings.ccMs),
			linkMs: roundedMs(input.timings.linkMs),
			runMs: roundedMs(input.timings.runMs),
		},
	};
}
