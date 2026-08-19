import { describe, expect, it } from "vitest";
import { buildCoreControlFlow } from "../src/core-ir-control-flow.ts";
import { verifyCoreFunction } from "../src/core-ir-verifier.ts";
import {
	CORE_NO_EFFECTS,
	CoreFunctionBuilder,
	CoreOpcodeRegistry,
	coreArity,
	formatCoreFunction,
} from "../src/core-ir.ts";

function registry(): CoreOpcodeRegistry {
	const registry = new CoreOpcodeRegistry();
	registry.define({
		opcode: "constant",
		inputs: coreArity(0),
		outputs: coreArity(1),
		effects: CORE_NO_EFFECTS,
	});
	registry.define({
		opcode: "add",
		inputs: coreArity(2),
		outputs: coreArity(1),
		effects: CORE_NO_EFFECTS,
	});
	registry.define({
		opcode: "call",
		inputs: coreArity(1, 16),
		outputs: coreArity(1),
		effects: {
			reads: ["global-property", "object-property"],
			writes: ["global-property", "object-property"],
			mayThrow: true,
			maySuspend: false,
			mayGc: true,
			callsUserCode: true,
		},
	});
	return registry;
}

describe("Core IR", () => {
	it("builds, verifies, prints, and analyzes block-parameter SSA", () => {
		const opcodes = registry();
		const builder = new CoreFunctionBuilder(3, opcodes);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const consequent = builder.createBlock();
		const alternate = builder.createBlock();
		const merge = builder.createBlock([{ representation: "f64" }]);
		const condition = builder.block(entry).parameters[0]!.value;
		const [left] = builder.appendInstruction(consequent, "constant", [], {
			outputRepresentations: ["f64"],
			payload: { value: 1 },
		});
		const [right] = builder.appendInstruction(alternate, "constant", [], {
			outputRepresentations: ["f64"],
			payload: { value: 2 },
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition,
			consequent: { block: consequent, arguments: [] },
			alternate: { block: alternate, arguments: [] },
		});
		builder.setTerminator(consequent, {
			kind: "jump",
			edge: { block: merge, arguments: [left!] },
		});
		builder.setTerminator(alternate, {
			kind: "jump",
			edge: { block: merge, arguments: [right!] },
		});
		builder.setTerminator(merge, {
			kind: "return",
			value: builder.block(merge).parameters[0]!.value,
		});
		const fn = builder.finish(entry);

		expect(() => verifyCoreFunction(fn, opcodes)).not.toThrow();
		const cfg = buildCoreControlFlow(fn, opcodes);
		expect(cfg.dominates(entry, merge)).toBe(true);
		expect(cfg.dominates(consequent, merge)).toBe(false);
		expect(formatCoreFunction(fn)).toContain("branch %0, b1(), b2()");
		expect(formatCoreFunction(fn)).toContain("b3(%1: f64)");
	});

	it("rejects values that do not dominate an incoming edge", () => {
		const opcodes = registry();
		const builder = new CoreFunctionBuilder(0, opcodes);
		const entry = builder.createBlock([{ representation: "boolean" }]);
		const leftBlock = builder.createBlock();
		const rightBlock = builder.createBlock();
		const merge = builder.createBlock([{ representation: "boxed" }]);
		const [left] = builder.appendInstruction(leftBlock, "constant", []);
		builder.setTerminator(entry, {
			kind: "branch",
			condition: builder.block(entry).parameters[0]!.value,
			consequent: { block: leftBlock, arguments: [] },
			alternate: { block: rightBlock, arguments: [] },
		});
		builder.setTerminator(leftBlock, {
			kind: "jump",
			edge: { block: merge, arguments: [left!] },
		});
		builder.setTerminator(rightBlock, {
			kind: "jump",
			edge: { block: merge, arguments: [left!] },
		});
		builder.setTerminator(merge, {
			kind: "return",
			value: builder.block(merge).parameters[0]!.value,
		});

		expect(() => verifyCoreFunction(builder.finish(entry), opcodes)).toThrow(
			/does not dominate b2/,
		);
	});

	it("models exception flow with a block-entry handler contract", () => {
		const opcodes = registry();
		const builder = new CoreFunctionBuilder(0, opcodes);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const handler = builder.createBlock([
			{ role: "exception", representation: "boxed" },
			{ representation: "boxed" },
		]);
		const input = builder.block(entry).parameters[0]!.value;
		const [result] = builder.appendInstruction(entry, "call", [input]);
		builder.setHandler(entry, handler, [input]);
		builder.setTerminator(entry, { kind: "return", value: result! });
		builder.setTerminator(handler, {
			kind: "return",
			value: builder.block(handler).parameters[1]!.value,
		});
		const fn = builder.finish(entry);

		expect(() => verifyCoreFunction(fn, opcodes)).not.toThrow();
		expect(buildCoreControlFlow(fn, opcodes).successors[entry]).toEqual([
			expect.objectContaining({ to: handler, kind: "exceptional" }),
		]);

		const invalid = new CoreFunctionBuilder(0, opcodes);
		const invalidEntry = invalid.createBlock([{ representation: "boxed" }]);
		const invalidHandler = invalid.createBlock([
			{ role: "exception" },
			{ representation: "boxed" },
		]);
		const [late] = invalid.appendInstruction(
			invalidEntry,
			"call",
			[invalid.block(invalidEntry).parameters[0]!.value],
			{
				outputCount: 1,
			},
		);
		invalid.setHandler(invalidEntry, invalidHandler, [late!]);
		invalid.setTerminator(invalidEntry, { kind: "return", value: late! });
		invalid.setTerminator(invalidHandler, {
			kind: "return",
			value: invalid.block(invalidHandler).parameters[1]!.value,
		});
		expect(() => verifyCoreFunction(invalid.finish(invalidEntry), opcodes)).toThrow(
			/not available at block entry/,
		);
	});

	it("requires guarded provenance before asserted facts refine effects", () => {
		const opcodes = registry();
		const builder = new CoreFunctionBuilder(0, opcodes);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const fact = builder.addFact({
			kind: "typescript-type",
			value: "number",
			validity: { kind: "asserted", source: "fixture.ts" },
			obligations: [],
			origin: "test",
		});
		const [result] = builder.appendInstruction(
			entry,
			"call",
			[builder.block(entry).parameters[0]!.value],
			{ effectRefinement: { effects: CORE_NO_EFFECTS, proof: fact } },
		);
		builder.setTerminator(entry, { kind: "return", value: result! });

		expect(() => verifyCoreFunction(builder.finish(entry), opcodes)).toThrow(
			/asserted fact .* without a guard/,
		);
	});
});
