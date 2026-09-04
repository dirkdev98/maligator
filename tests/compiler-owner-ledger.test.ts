import { describe, expect, it } from "vitest";
import {
	compareCompilerOwnerLedgers,
	compilerOwnerCoverage,
} from "../scripts/compiler-owner-ledger.ts";
import {
	coreOptimizationOwnerIsOptimizeCore,
	CORE_OPTIMIZATION_OWNER,
	CORE_OPTIMIZATION_OWNERS,
} from "../src/compiler/core/core-optimization-owners.ts";
import type { CoreOptimizationOwnerReport } from "../src/compiler/core/core-optimization-owners.ts";

function ledger(hostScale: number): ReadonlyArray<CoreOptimizationOwnerReport> {
	return CORE_OPTIMIZATION_OWNERS.map(({ id, name }) => ({
		id,
		name,
		elapsedMs: id === CORE_OPTIMIZATION_OWNER.unattributed ? hostScale : id * hostScale,
		workUnits: id,
		...(hostScale === 2 ? { allocatedBytes: id * 100 } : {}),
	}));
}

describe("compiler owner ledger", () => {
	it("compares stable owners and derives per-work costs", () => {
		const owners = compareCompilerOwnerLedgers(ledger(1), ledger(2));
		const fused = owners[CORE_OPTIMIZATION_OWNER.fusedLocalOptimization]!;

		expect(fused).toMatchObject({
			id: CORE_OPTIMIZATION_OWNER.fusedLocalOptimization,
			nodeMs: 4,
			maligatorMs: 8,
			hostRatio: 2,
			hostGapMs: 4,
			workUnits: 4,
			nodeNsPerWorkUnit: 1_000_000,
			maligatorNsPerWorkUnit: 2_000_000,
			allocatedBytes: 400,
		});
		expect(owners[CORE_OPTIMIZATION_OWNER.unattributed]!.hostRatio).toBe(2);
		expect(owners[CORE_OPTIMIZATION_OWNER.unattributed]!.nodeNsPerWorkUnit).toBeNull();
	});

	it("rejects host-dependent work", () => {
		const maligator = ledger(2).map((owner) =>
			owner.id === CORE_OPTIMIZATION_OWNER.memoryVersions
				? { ...owner, workUnits: owner.workUnits + 1 }
				: owner,
		);

		expect(() => compareCompilerOwnerLedgers(ledger(1), maligator)).toThrow(
			"work differs between hosts",
		);
	});

	it("reports optimizer, host-gap and allocation coverage", () => {
		const owners = compareCompilerOwnerLedgers(ledger(1), ledger(2));
		const optimizeSum = owners
			.filter(({ id }) => coreOptimizationOwnerIsOptimizeCore(id))
			.reduce((sum, owner) => sum + owner.nodeMs, 0);
		const attributedGap = owners
			.filter(({ id }) => id !== CORE_OPTIMIZATION_OWNER.unattributed)
			.reduce((sum, owner) => sum + owner.hostGapMs, 0);
		const totalAllocated = owners.reduce(
			(sum, owner) => sum + (owner.allocatedBytes ?? 0),
			0,
		);

		expect(
			compilerOwnerCoverage(owners, {
				nodeOptimizeCoreMs: optimizeSum,
				maligatorOptimizeCoreMs: optimizeSum * 2,
				nodeWallMs: 100,
				maligatorWallMs: 100 + attributedGap,
			}),
		).toEqual({
			nodeOptimizeCore: 1,
			maligatorOptimizeCore: 1,
			hostGap: 1,
			allocation:
				(totalAllocated - owners[CORE_OPTIMIZATION_OWNER.unattributed]!.allocatedBytes!) /
				totalAllocated,
		});
	});
});
