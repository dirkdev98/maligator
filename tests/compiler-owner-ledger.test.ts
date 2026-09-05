import { describe, expect, it } from "vitest";
import {
	compareCompilerOwnerLedgers,
	compilerOwnerCoverage,
} from "../scripts/compiler-owner-ledger.ts";
import {
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
		const owners = compareCompilerOwnerLedgers(
			[
				{ id: 0, name: "unattributed", elapsedMs: 7, workUnits: 0 },
				{ id: 1, name: "semantic-to-Core construction", elapsedMs: 10, workUnits: 1 },
				{ id: 2, name: "construction structural cleanup", elapsedMs: 20, workUnits: 1 },
			],
			[
				{ id: 0, name: "unattributed", elapsedMs: 17, workUnits: 0, allocatedBytes: 100 },
				{
					id: 1,
					name: "semantic-to-Core construction",
					elapsedMs: 30,
					workUnits: 1,
					allocatedBytes: 200,
				},
				{
					id: 2,
					name: "construction structural cleanup",
					elapsedMs: 50,
					workUnits: 1,
					allocatedBytes: 500,
				},
			],
		);

		expect(
			compilerOwnerCoverage(owners, {
				nodeOptimizeCoreMs: 80,
				maligatorOptimizeCoreMs: 100,
				nodeWallMs: 100,
				maligatorWallMs: 300,
			}),
		).toEqual({
			nodeOptimizeCore: 0.25,
			maligatorOptimizeCore: 0.5,
			hostGap: 0.25,
			allocation: 0.875,
		});
	});
});
