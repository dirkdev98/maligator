import { deepStrictEqual, equal } from "node:assert";
import { describe, it } from "vitest";
import type {
	CoreAccessKey,
	CoreProvenance,
} from "../src/compiler/core/core-ir-provenance.ts";
import {
	analyzeCoreShapeProvenance,
	CORE_SHAPE_CANDIDATES_OPAQUE,
} from "../src/compiler/core/core-ir-shape-provenance.ts";
import type { CoreFunctionId, CoreValueId } from "../src/compiler/core/core-ir.ts";
import type { CoreProgram } from "../src/compiler/core/core-store.ts";

const value = (index: number) => index as CoreValueId;

function fixture(count: number, slots: Set<number>) {
	const layouts = Array.from({ length: count }, (_, index) => ({
		kind: "named-slots",
		instruction: index,
		keys: [7, 8],
	}));
	const rows = new Map<number, { opcode: string; index?: number; operand?: number }>();
	for (let index = 0; index < count; index++) {
		rows.set(10 + index, { opcode: "storeGlobal", index: 9, operand: index });
	}
	rows.set(100, { opcode: "loadGlobal", index: 9 });
	rows.set(101, { opcode: "move", operand: 100 });
	rows.set(102, { opcode: "move", operand: 102 });
	const fn = {
		instructionIds: () => rows.keys(),
		instructionKind: () => "operation",
		instructionOpcodeName: (id: number) => rows.get(id)?.opcode ?? "createObjectShaped",
		instructionAttributes: (id: number) => ({ index: rows.get(id)?.index }),
		kernel: {
			instructionOperandCount: (id: number) =>
				rows.get(id)?.operand === undefined ? 0 : 1,
			instructionOperandStart: (id: number) => id,
			operandAt: (id: number) => rows.get(id)!.operand,
			valueDefinitionKind: () => 1,
			valueDefinitionOwner: (id: number) => id,
		},
	};
	const provenance = {
		layouts,
		allocationOf: (id: number) => layouts[id],
		escape: () => "contained",
		ownCell: (id: number) =>
			layouts[id] === undefined
				? undefined
				: {
						layout: layouts[id],
						cell: { kind: "object-slot", key: 8 },
					},
	} as unknown as CoreProvenance;
	return analyzeCoreShapeProvenance(
		{ function: () => fn } as unknown as CoreProgram,
		0 as CoreFunctionId,
		provenance,
		slots,
	);
}

describe("Global shape-candidate admission", () => {
	it("retains local shape proofs without closed global slots", () => {
		const analysis = fixture(1, new Set());
		equal(analysis.candidates(value(0), "write").opaque, false);
		equal(analysis.candidates(value(101)), CORE_SHAPE_CANDIDATES_OPAQUE);
		equal(analysis.candidates(value(102)), CORE_SHAPE_CANDIDATES_OPAQUE);
		const slot = analysis.exactOwnSlot(value(0), {} as CoreAccessKey, "read");
		equal(slot?.slot, 1);
		deepStrictEqual(analysis.statistics, {
			allocations: 1,
			contained: 1,
			exactSlotQueries: 1,
		});
	});

	it("keeps empty origin sets opaque even when global slots are closed", () => {
		const analysis = fixture(0, new Set([9]));
		equal(analysis.candidates(value(101)), CORE_SHAPE_CANDIDATES_OPAQUE);
		equal(analysis.statistics.allocations, 0);
	});

	it("preserves closed-slot move chains, write restrictions and origin overflow", () => {
		const analysis = fixture(4, new Set([9]));
		const candidates = analysis.candidates(value(101));
		equal(candidates.opaque, false);
		deepStrictEqual(
			candidates.origins.map((origin) => origin.instruction),
			[0, 1, 2, 3],
		);
		equal(analysis.candidates(value(101), "write"), CORE_SHAPE_CANDIDATES_OPAQUE);
		equal(analysis.candidates(value(102)), CORE_SHAPE_CANDIDATES_OPAQUE);
		equal(fixture(5, new Set([9])).candidates(value(101)), CORE_SHAPE_CANDIDATES_OPAQUE);
	});
});
