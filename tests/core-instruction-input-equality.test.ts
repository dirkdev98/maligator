import { equal } from "node:assert";
import { describe, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	coreAttributeValuesEqual,
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
});
