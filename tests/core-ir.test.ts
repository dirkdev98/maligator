import { describe, expect, it } from "vitest";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "../src/core-ir-control-flow.ts";
import { CORE_OPCODES, coreOpcodeRegistry } from "../src/core-ir-opcodes.ts";
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
		discardable: true,
	});
	registry.define({
		opcode: "add",
		inputs: coreArity(2),
		outputs: coreArity(1),
		effects: CORE_NO_EFFECTS,
		discardable: true,
	});
	registry.define({
		opcode: "move",
		inputs: coreArity(1),
		outputs: coreArity(1),
		effects: CORE_NO_EFFECTS,
		discardable: true,
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
		discardable: false,
	});
	return registry;
}

describe("Core IR", () => {
	it("keeps structural control out of opcodes and enforces exact arities", () => {
		expect(CORE_OPCODES).not.toEqual(
			expect.arrayContaining([
				"catch",
				"jump",
				"jumpIf",
				"return",
				"sourcePos",
				"throw",
				"tryBegin",
				"tryEnd",
			]),
		);
		expect(coreOpcodeRegistry.require("binary").inputs).toEqual({
			minimum: 2,
			maximum: 2,
		});
		expect(coreOpcodeRegistry.require("call").inputs).toEqual({
			minimum: 2,
			maximum: 65_535,
		});
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock([{ representation: "boxed" }]);
		expect(() =>
			builder.appendInstruction(entry, "binary", [
				builder.block(entry).parameters[0]!.value,
			]),
		).toThrow(/binary expects 2\.\.2 inputs/);
	});

	it("builds, verifies, prints, and analyzes block-parameter SSA", () => {
		const opcodes = registry();
		const builder = new CoreFunctionBuilder(3, opcodes, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const consequent = builder.createBlock();
		const alternate = builder.createBlock();
		const merge = builder.createBlock([{ representation: "f64" }]);
		const condition = builder.block(entry).parameters[0]!.value;
		const [left] = builder.appendInstruction(consequent, "constant", [], {
			outputRepresentations: ["f64"],
			attributes: { value: 1 },
		});
		const [right] = builder.appendInstruction(alternate, "constant", [], {
			outputRepresentations: ["f64"],
			attributes: { value: 2 },
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
		const canonical = coreCanonicalValueRoots(fn, cfg);
		const mergeValue = builder.block(merge).parameters[0]!.value;
		expect(canonical.get(mergeValue)).toBe(mergeValue);
		expect(canonical.get(mergeValue)).not.toBe(canonical.get(left!));
		expect(canonical.get(mergeValue)).not.toBe(canonical.get(right!));
		expect(formatCoreFunction(fn)).toContain("branch %0, b1(), b2()");
		expect(formatCoreFunction(fn)).toContain("b3(%1: f64)");
	});

	it("canonicalizes moves and loop-carried copies to their external producer", () => {
		const opcodes = registry();
		const builder = new CoreFunctionBuilder(0, opcodes, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const header = builder.createBlock([{ representation: "boxed" }]);
		const body = builder.createBlock();
		const exit = builder.createBlock([{ representation: "boxed" }]);
		const input = builder.block(entry).parameters[0]!.value;
		const loopValue = builder.block(header).parameters[0]!.value;
		const [moved] = builder.appendInstruction(body, "move", [loopValue]);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [input] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: input,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [loopValue] },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [moved!] },
		});
		const result = builder.block(exit).parameters[0]!.value;
		builder.setTerminator(exit, { kind: "return", value: result });
		const fn = builder.finish(entry);

		expect(() => verifyCoreFunction(fn, opcodes)).not.toThrow();
		const canonical = coreCanonicalValueRoots(fn, buildCoreControlFlow(fn, opcodes));
		expect(canonical.get(loopValue)).toBe(input);
		expect(canonical.get(moved!)).toBe(input);
		expect(canonical.get(result)).toBe(input);
	});

	it("rejects values that do not dominate an incoming edge", () => {
		const opcodes = registry();
		const builder = new CoreFunctionBuilder(0, opcodes, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
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
		const builder = new CoreFunctionBuilder(0, opcodes, { parameterCount: 1 });
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

		const invalid = new CoreFunctionBuilder(0, opcodes, { parameterCount: 1 });
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
		const builder = new CoreFunctionBuilder(0, opcodes, { parameterCount: 1 });
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

	it("allows a runtime guard to establish a fact on only its success edge", () => {
		const opcodes = registry();
		const builder = new CoreFunctionBuilder(0, opcodes, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const fast = builder.createBlock([{ representation: "boxed" }]);
		const fallback = builder.createBlock([{ representation: "boxed" }]);
		const [condition, input] = builder.block(entry).parameters.map(({ value }) => value);
		const fact = builder.setGuardTerminator(entry, {
			condition: condition!,
			success: { block: fast, arguments: [input!] },
			fallback: { block: fallback, arguments: [input!] },
			fact: {
				kind: "exact-call-target",
				value: 7,
				origin: "test",
				obligations: [{ kind: "fallback", id: "generic-call" }],
			},
		});
		const [result] = builder.appendInstruction(
			fast,
			"call",
			[builder.block(fast).parameters[0]!.value],
			{ effectRefinement: { effects: CORE_NO_EFFECTS, proof: fact } },
		);
		builder.setTerminator(fast, { kind: "return", value: result! });
		builder.setTerminator(fallback, {
			kind: "return",
			value: builder.block(fallback).parameters[0]!.value,
		});

		const fn = builder.finish(entry);
		expect(() => verifyCoreFunction(fn, opcodes)).not.toThrow();
		expect(formatCoreFunction(fn)).toContain("guard %0 proves !0");
	});

	it("rejects a guarded fact after its success and fallback paths merge", () => {
		const opcodes = registry();
		const builder = new CoreFunctionBuilder(0, opcodes, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const success = builder.createBlock([{ representation: "boxed" }]);
		const merge = builder.createBlock([{ representation: "boxed" }]);
		const [condition, input] = builder.block(entry).parameters.map(({ value }) => value);
		const fact = builder.setGuardTerminator(entry, {
			condition: condition!,
			success: { block: success, arguments: [input!] },
			fallback: { block: merge, arguments: [input!] },
			fact: { kind: "exact-call-target", value: 7, origin: "test" },
		});
		builder.setTerminator(success, {
			kind: "jump",
			edge: {
				block: merge,
				arguments: [builder.block(success).parameters[0]!.value],
			},
		});
		const [result] = builder.appendInstruction(
			merge,
			"call",
			[builder.block(merge).parameters[0]!.value],
			{ effectRefinement: { effects: CORE_NO_EFFECTS, proof: fact } },
		);
		builder.setTerminator(merge, { kind: "return", value: result! });

		expect(() => verifyCoreFunction(builder.finish(entry), opcodes)).toThrow(
			/does not dominate/,
		);
	});

	it("requires certificate data references to belong to the claimed slice", () => {
		const opcodes = registry();
		const builder = new CoreFunctionBuilder(0, opcodes);
		const entry = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "constant", []);
		builder.setTerminator(entry, { kind: "return", value: value! });
		const complete = builder.finish(entry);
		const producer = complete.blocks[0]!.instructions[0]!;
		const terminator = complete.blocks[0]!.terminator;
		const invalid = {
			...complete,
			regions: [
				{
					kind: "test-certificate",
					anchors: [terminator.id],
					claimedInstructions: [terminator.id],
					ordinaryBlocks: [entry],
					exceptionalBlocks: [],
					data: { producer: { $coreInstruction: producer.id } },
				},
			],
		};

		expect(() => verifyCoreFunction(invalid, opcodes)).toThrow(/not claimed/);
	});
});
