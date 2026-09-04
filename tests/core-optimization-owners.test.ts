import { describe, expect, it } from "vitest";
import {
	completeCompilerOptimizationOwners,
	CORE_OPTIMIZATION_OWNER,
	CORE_OPTIMIZATION_OWNERS,
	subtractCoreOptimizationRuntimeCounters,
} from "../src/compiler/core/core-optimization-owners.ts";
import type { CoreOptimizationOwnerReport } from "../src/compiler/core/core-optimization-owners.ts";

function coreOwners(withRuntime: boolean): ReadonlyArray<CoreOptimizationOwnerReport> {
	return CORE_OPTIMIZATION_OWNERS.map(({ id, name }) => ({
		id,
		name,
		elapsedMs: id,
		workUnits: id * 2,
		...(withRuntime ? { allocatedBytes: id * 10, collections: id } : {}),
	}));
}

const phases = {
	graphMs: 1,
	semanticMs: 2,
	constructCoreMs: 3,
	optimizeCoreMs: 4,
	coreToExecutionMs: 5,
	executionToImageMs: 6,
	emitMs: 7,
	serializeMs: 8,
	writeMs: 9,
};

describe("compiler optimization owners", () => {
	it("merges optimizer owners with exclusive top-level compiler phases", () => {
		const owners = completeCompilerOptimizationOwners(
			coreOwners(true),
			phases,
			{ inputInstructions: 100, outputInstructions: 80, generatedCodeUnits: 60 },
			{
				graphMs: { allocatedBytes: 10, collections: 1 },
				semanticMs: { allocatedBytes: 20, collections: 2 },
				constructCoreMs: { allocatedBytes: 30, collections: 3 },
				coreToExecutionMs: { allocatedBytes: 50, collections: 5 },
				executionToImageMs: { allocatedBytes: 60, collections: 6 },
				emitMs: { allocatedBytes: 70, collections: 7 },
				serializeMs: { allocatedBytes: 80, collections: 8 },
				writeMs: { allocatedBytes: 90, collections: 9 },
			},
		);

		expect(owners[CORE_OPTIMIZATION_OWNER.semanticToCore]).toMatchObject({
			elapsedMs: 3,
			workUnits: 100,
			allocatedBytes: 30,
			collections: 3,
		});
		expect(owners[CORE_OPTIMIZATION_OWNER.fusedLocalOptimization]).toMatchObject({
			elapsedMs: 4,
			workUnits: 8,
			allocatedBytes: 40,
			collections: 4,
		});
		expect(owners[CORE_OPTIMIZATION_OWNER.unattributed]).toMatchObject({
			elapsedMs: 0,
			allocatedBytes: 0,
			collections: 0,
		});
		expect(owners[CORE_OPTIMIZATION_OWNER.moduleGraph]).toMatchObject({
			elapsedMs: 1,
			workUnits: 0,
			allocatedBytes: 10,
			collections: 1,
		});
		expect(owners[CORE_OPTIMIZATION_OWNER.semanticAnalysis]).toMatchObject({
			elapsedMs: 2,
			workUnits: 100,
			allocatedBytes: 20,
			collections: 2,
		});
		expect(owners[CORE_OPTIMIZATION_OWNER.outputWriting]).toMatchObject({
			elapsedMs: 9,
			workUnits: 60,
			allocatedBytes: 90,
			collections: 9,
		});
	});

	it("omits unavailable runtime counters", () => {
		const owners = completeCompilerOptimizationOwners(coreOwners(false), phases, {
			inputInstructions: 100,
			outputInstructions: 80,
			generatedCodeUnits: 60,
		});

		expect(owners.every((owner) => owner.allocatedBytes === undefined)).toBe(true);
		expect(owners.every((owner) => owner.collections === undefined)).toBe(true);
	});

	it("subtracts monotonic runtime snapshots", () => {
		expect(
			subtractCoreOptimizationRuntimeCounters(
				{ allocatedBytes: 100, collections: 2 },
				{ allocatedBytes: 180, collections: 5 },
			),
		).toEqual({ allocatedBytes: 80, collections: 3 });
	});
});
