import { equal } from "node:assert";
import { describe, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	coreAttributeValuesEqual,
	coreAttributeValueHash,
	coreInstructionInputsHash,
	coreInstructionInputsEqual,
} from "../src/compiler/core/core-ir-equality.ts";
import { analysisProgram } from "./helpers/core-program-analysis.ts";

describe("Core instruction input equality", () => {
	it("checks opcode, operands, overrides and attributes independently", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [x] = builder.appendInstruction(entry, "createUndefined", []);
		const [y] = builder.appendInstruction(entry, "createUndefined", []);
		builder.appendInstruction(entry, "binary", [x!, y!], {
			attributes: { operator: "+" },
		});
		builder.appendInstruction(entry, "binary", [x!, y!], {
			attributes: { operator: "+" },
		});
		builder.appendInstruction(entry, "binary", [y!, x!], {
			attributes: { operator: "+" },
		});
		builder.appendInstruction(entry, "binary", [x!, y!], {
			attributes: { operator: "-" },
		});
		const [first, , left, same, swapped, subtract] = builder.bodyInstructionIds(entry);
		builder.setTerminator(entry, { kind: "return", value: x! });
		const fn = program.function(builder.finish(entry).function);
		equal(coreInstructionInputsEqual(fn, left!, same!), true);
		equal(coreInstructionInputsHash(fn, left!), coreInstructionInputsHash(fn, same!));
		equal(coreInstructionInputsEqual(fn, left!, swapped!), false);
		equal(coreInstructionInputsEqual(fn, left!, subtract!), false);
		equal(coreInstructionInputsEqual(fn, first!, left!), false);
		equal(coreInstructionInputsEqual(fn, left!, swapped!, [x!, y!], [x!, y!]), true);
		equal(coreInstructionInputsEqual(fn, left!, left!, [x!], [x!, y!]), false);
	});

	it("retains SameValue distinctions in nested attributes", () => {
		equal(coreAttributeValuesEqual({ values: [NaN, -0] }, { values: [NaN, -0] }), true);
		equal(coreAttributeValuesEqual({ values: [NaN, -0] }, { values: [NaN, 0] }), false);
	});
	it("hashes equal nested attributes consistently regardless of key order or NaN payload", () => {
		const view = new DataView(new ArrayBuffer(8));
		view.setBigUint64(0, 0x7ff8_0000_0000_0001n);
		const alternateNaN = view.getFloat64(0);
		const left = { values: [NaN, -0, undefined], nested: { x: 1, y: null } };
		const right = { nested: { y: null, x: 1 }, values: [alternateNaN, -0, undefined] };
		equal(coreAttributeValuesEqual(left, right), true);
		equal(coreAttributeValueHash(0, left), coreAttributeValueHash(0, right));
	});
});
