import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import {
	CORE_SHAPE_CANDIDATES_OPAQUE,
	analyzeCoreShapeProvenance,
	coreExactShapeOwnSlotFromAttribute,
	coreKnownOwnSlotFromAttribute,
	coreShapeCaseCandidatesFromAttribute,
} from "../src/compiler/core/core-ir-shape-provenance.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { inspectCoreBlockParameters } from "./helpers/core-inspection.ts";

function program(): CoreProgram {
	return new CoreProgram(coreOpcodeRegistry, {
		stringConstants: [[0x78], [0x79]],
	});
}

describe("Core local shape provenance", () => {
	it("proves the exact physical slot of a contained shaped allocation", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [first] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [second] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
		});
		const [object] = builder.appendInstruction(
			entry,
			"createObjectShaped",
			[first!, second!],
			{
				attributes: { keyStringIndices: [0, 1] },
			},
		);
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 1 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);
		const analysis = analyzeCoreShapeProvenance(core, finished.function);
		const slot = analysis.exactOwnSlot(
			object!,
			{ kind: "string-constant", index: 1 },
			"read",
		);
		expect(slot).toMatchObject({ slot: 1, origin: { function: finished.function } });
		expect(analysis.candidates(object!)).toMatchObject({
			opaque: false,
			origins: [{ keys: [0, 1] }],
		});
	});

	it("does not publish an exact slot after an out-of-layout access", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [first] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [first!], {
			attributes: { keyStringIndices: [0] },
		});
		const [loaded] = builder.appendInstruction(entry, "loadPropertyStatic", [object!], {
			attributes: { stringIndex: 1 },
		});
		builder.setTerminator(entry, { kind: "return", value: loaded! });
		const finished = builder.finish(entry);
		const analysis = analyzeCoreShapeProvenance(core, finished.function);
		expect(
			analysis.exactOwnSlot(object!, { kind: "string-constant", index: 0 }, "read"),
		).toBeUndefined();
	});

	it("keeps opaque values separate from finite allocation origins", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		builder.setTerminator(entry, { kind: "return", value: parameter });
		const finished = builder.finish(entry);
		expect(
			analyzeCoreShapeProvenance(core, finished.function).candidates(parameter),
		).toBe(CORE_SHAPE_CANDIDATES_OPAQUE);
	});

	it("carries a shaped origin through a closed global slot", () => {
		const core = program();
		const builder = new CoreFunctionBuilder(core);
		const entry = builder.createBlock();
		const [first] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
		});
		const [object] = builder.appendInstruction(entry, "createObjectShaped", [first!], {
			attributes: { keyStringIndices: [0] },
		});
		builder.appendInstruction(entry, "storeGlobal", [object!], {
			outputCount: 0,
			attributes: { index: 0 },
		});
		const [loaded] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 0 },
		});
		const [result] = builder.appendInstruction(entry, "loadPropertyStatic", [loaded!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: result! });
		const finished = builder.finish(entry);
		const analysis = analyzeCoreShapeProvenance(
			core,
			finished.function,
			undefined,
			new Set([0]),
		);
		expect(analysis.candidates(loaded!)).toMatchObject({
			opaque: false,
			origins: [{ function: finished.function, keys: [0] }],
		});
		expect(analysis.candidates(loaded!, "write")).toBe(CORE_SHAPE_CANDIDATES_OPAQUE);
	});

	it("parses target certificates without trusting malformed candidate data", () => {
		const known = {
			candidates: [{ shapeFunctionIndex: 0, shapeInstruction: 3, slot: 1 }],
		};
		expect(coreKnownOwnSlotFromAttribute(known)).toEqual(known);
		expect(coreKnownOwnSlotFromAttribute({ candidates: [] })).toBeUndefined();
		expect(
			coreKnownOwnSlotFromAttribute({
				candidates: [known.candidates[0], known.candidates[0]],
			}),
		).toBeUndefined();
		expect(
			coreShapeCaseCandidatesFromAttribute([
				{ shapeFunctionIndex: 0, shapeInstruction: 3 },
			]),
		).toHaveLength(1);
	});

	it("requires a bounded slot and nonempty origins for exact-shape certificates", () => {
		expect(
			coreExactShapeOwnSlotFromAttribute({
				slot: 2,
				origins: [{ shapeFunctionIndex: 0, shapeInstruction: 3 }],
			}),
		).toMatchObject({ slot: 2 });
		expect(coreExactShapeOwnSlotFromAttribute({ slot: 64, origins: [] })).toBeUndefined();
	});
});
