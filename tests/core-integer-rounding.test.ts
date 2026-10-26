import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "../src/compiler/core/core-ir-control-flow.ts";
import { analyzeCoreLoopInductions } from "../src/compiler/core/core-ir-loops.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { analyzeCoreValueKinds } from "../src/compiler/core/core-ir-value-kinds.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { coreInstructionFacts } from "../src/compiler/core/core-native-instruction-facts.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import { COMPILER_INT32_RANGE } from "../src/compiler/shared/integer-range.ts";

function rounding(
	opcode: "mathUnaryNumber" | "callKnown" | "call",
	operation: string,
	attributes: { readonly construct?: boolean; readonly argumentMode?: string } = {},
) {
	const program = new CoreProgram(coreOpcodeRegistry);
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const block = builder.createBlock([{}]);
	const parameter = builder.blockParameterValue(block, 0);
	const [zero] = builder.appendInstruction(block, "createNumber", [], {
		attributes: { value: 0 },
		outputRepresentations: ["i32"],
	});
	const [integer] = builder.appendInstruction(block, "binary", [parameter, zero!], {
		attributes: { operator: "|" },
		outputRepresentations: ["i32"],
	});
	const input = integer!;
	const [receiver] = builder.appendInstruction(block, "createUndefined", []);
	const [result] = builder.appendInstruction(
		block,
		opcode,
		opcode === "mathUnaryNumber"
			? [input]
			: opcode === "callKnown"
				? [receiver!, input]
				: [receiver!, receiver!, input],
		{
			attributes:
				opcode === "call"
					? { knownBuiltinCall: { operation }, ...attributes }
					: { operation, ...attributes },
			outputRepresentations: opcode === "call" ? ["boxed"] : ["f64"],
		},
	);
	builder.setTerminator(block, { kind: "return", value: result! });
	const id = builder.finish(block).function,
		fn = program.function(id),
		cfg = buildCoreControlFlow(program, id);
	const kinds = analyzeCoreValueKinds(fn, cfg);
	const ranges = analyzeCoreLoopInductions(
		fn,
		cfg,
		coreCanonicalValueRoots(fn, cfg),
		(value) => kinds.exactScalar(value),
	);
	const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(result!));
	const facts = coreInstructionFacts(fn, instruction, kinds, true, (value, block) =>
		ranges.range(value, block),
	);
	return {
		range: ranges.range(result!),
		kind: kinds.exactScalar(result!),
		facts,
		fn,
		result: result!,
	};
}

describe("Core integer rounding payloads", () => {
	it.each(["mathUnaryNumber", "callKnown"] as const)(
		"keeps an integer payload in %s despite floating storage",
		(opcode) => {
			for (const operation of ["Math.floor", "Math.ceil", "Math.trunc", "Math.round"]) {
				const out = rounding(opcode, operation);
				expect(out.fn.valueRepresentation(out.result)).toBe("f64");
				expect(out.kind).toBe("int32");
				expect(out.range).toEqual(COMPILER_INT32_RANGE);
				expect(out.facts.resultIntegerRanges).toEqual([COMPILER_INT32_RANGE]);
			}
		},
	);
	it("keeps an ordinary call hint separate from a known rounding operation", () => {
		const out = rounding("call", "Math.round");
		expect(out.range).toBeUndefined();
		expect(out.kind).toBeUndefined();
		expect(out.facts.resultIntegerRanges).toBeUndefined();
	});
	it.each([{ construct: true }, { argumentMode: "array-like" }])(
		"rejects non-positional or constructing builtin transport %j",
		(attributes) => {
			const out = rounding("callKnown", "Math.round", attributes);
			expect(out.range).toBeUndefined();
			expect(out.kind).not.toBe("int32");
			expect(out.facts.resultIntegerRanges).toBeUndefined();
		},
	);
	it("does not treat precision-reducing Math as an integer identity", () => {
		const out = rounding("mathUnaryNumber", "Math.fround");
		expect(out.kind).not.toBe("int32");
		expect(out.range).toBeUndefined();
	});
});
