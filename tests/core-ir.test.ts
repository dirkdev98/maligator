import { describe, expect, it } from "vitest";
import {
	buildCoreControlFlow,
	coreCanonicalValueRoots,
} from "../src/compiler/core/core-ir-control-flow.ts";
import {
	coreMemoryAccesses,
	coreMemoryLocationFamily,
	coreMemoryLocationIsExact,
	coreMemoryPartition,
} from "../src/compiler/core/core-ir-memory.ts";
import {
	CORE_OPCODES,
	coreOpcodeRegistry,
} from "../src/compiler/core/core-ir-opcodes.ts";
import { verifyCoreFunction } from "../src/compiler/core/core-ir-verifier.ts";
import {
	CORE_MEMORY_FAMILIES,
	CORE_MEMORY_FAMILY_DOMAINS,
	CORE_NO_EFFECTS,
	CoreFunctionBuilder,
	CoreOpcodeRegistry,
	coreArity,
	formatCoreFunction,
} from "../src/compiler/core/core-ir.ts";

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

	it("names every declared access against the effect domains it belongs to", () => {
		for (const descriptor of coreOpcodeRegistry.entries()) {
			for (const access of descriptor.accesses ?? []) {
				const declared =
					access.mode === "read" ? descriptor.effects.reads : descriptor.effects.writes;
				for (const domain of CORE_MEMORY_FAMILY_DOMAINS[access.family]) {
					expect(declared).toContain(domain);
				}
			}
		}
		// Families that can describe the same cell must share a domain, so one
		// family's write is never invisible to another family's reader.
		for (const family of CORE_MEMORY_FAMILIES) {
			expect(CORE_MEMORY_FAMILY_DOMAINS[family].length).toBeGreaterThan(0);
		}
		expect(CORE_MEMORY_FAMILY_DOMAINS["global-property"]).toContain("object-property");
		expect(CORE_MEMORY_FAMILY_DOMAINS.element).toContain("object-property");
		expect(CORE_MEMORY_FAMILIES).not.toContain("string");
		expect(CORE_MEMORY_FAMILIES).not.toContain("epoch");
	});

	it("rejects a descriptor whose access and effect domains disagree", () => {
		const opcodes = new CoreOpcodeRegistry();
		expect(() =>
			opcodes.define({
				opcode: "undeclaredSlotWrite",
				inputs: coreArity(1),
				outputs: coreArity(0),
				effects: CORE_NO_EFFECTS,
				discardable: false,
				accesses: [{ family: "global-slot", mode: "write", valueOperand: 0 }],
			}),
		).toThrow(/without declaring the global-slot effect domain/);
		expect(() =>
			opcodes.define({
				opcode: "outOfRangeValueOperand",
				inputs: coreArity(1),
				outputs: coreArity(0),
				effects: { ...CORE_NO_EFFECTS, writes: ["global-slot"] },
				discardable: false,
				accesses: [{ family: "global-slot", mode: "write", valueOperand: 3 }],
			}),
		).toThrow(/value operand 3 outside its 1\.\.1 inputs/);
		expect(() =>
			opcodes.define({
				opcode: "basedActivationSlot",
				inputs: coreArity(1),
				outputs: coreArity(1),
				effects: { ...CORE_NO_EFFECTS, reads: ["captured-slot"] },
				discardable: true,
				accesses: [{ family: "captured-slot", mode: "read", baseOperand: 0 }],
			}),
		).toThrow(/base or key for the activation-local family captured-slot/);
	});

	it("resolves exact compiler-slot locations and degrades heap accesses to a family", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [slot] = builder.appendInstruction(entry, "loadGlobal", [], {
			attributes: { index: 4 },
		});
		builder.appendInstruction(entry, "loadCaptured", [], {
			attributes: { functionIndex: 2, index: 1 },
		});
		const [self] = builder.appendInstruction(entry, "loadThis", []);
		// A store keeps its exact slot identity and names the value it forwards.
		builder.appendInstruction(entry, "storeGlobal", [slot!], {
			attributes: { index: 4 },
		});
		// A malformed slot attribute must widen to the family, never guess a cell.
		builder.appendInstruction(entry, "storeGlobal", [slot!], {
			attributes: { index: "four" },
		});
		const [property] = builder.appendInstruction(entry, "loadPropertyStatic", [self!], {
			attributes: { stringIndex: 0 },
		});
		builder.setTerminator(entry, { kind: "return", value: property! });
		const fn = builder.finish(entry);
		const instructions = fn.blocks[0]!.instructions;
		const locationOf = (index: number) => coreMemoryAccesses(instructions[index]!)[0]!;

		expect(locationOf(0).location).toEqual({ kind: "global-slot", slot: 4 });
		expect(locationOf(1).location).toEqual({
			kind: "captured-slot",
			owner: 2,
			index: 1,
		});
		expect(locationOf(2).location).toEqual({ kind: "activation-this" });
		expect(locationOf(3)).toMatchObject({ mode: "write", value: slot });
		expect(locationOf(4).location).toEqual({ kind: "family", family: "global-slot" });
		const heap = locationOf(5);
		expect(coreMemoryLocationIsExact(heap.location)).toBe(false);
		expect(coreMemoryLocationFamily(heap.location)).toBe("object-slot");
		// The declared base and key are recorded for the future alias oracle without
		// making the partition itself narrower than the whole family.
		expect(heap).toMatchObject({ base: self, key: 0 });
		expect(coreMemoryPartition({ kind: "global-slot", slot: 4 })).not.toBe(
			coreMemoryPartition({ kind: "global-slot", slot: 5 }),
		);
		expect(coreMemoryPartition({ kind: "local-slot", slot: 4 })).not.toBe(
			coreMemoryPartition({ kind: "global-slot", slot: 4 }),
		);
	});

	it("declares a fresh aggregate's layout and which results cannot be held weakly", () => {
		const shaped = coreOpcodeRegistry.require("createObjectShaped");
		expect(shaped.allocation).toStrictEqual({
			keysAttribute: "keyStringIndices",
			firstValueOperand: 0,
		});
		expect(coreOpcodeRegistry.require("createObject").allocation).toBeUndefined();
		// No JavaScript operator evaluates to an object or a symbol, so an operator
		// result's reachability is never observable; an intrinsic can be a well-known
		// symbol, which a registry accepts.
		expect(coreOpcodeRegistry.require("binary").resultCannotBeHeldWeakly).toBe(true);
		expect(coreOpcodeRegistry.require("unary").resultCannotBeHeldWeakly).toBe(true);
		expect(
			coreOpcodeRegistry.require("loadIntrinsic").resultCannotBeHeldWeakly,
		).toBeUndefined();
		expect(
			coreOpcodeRegistry.require("createObjectShaped").resultCannotBeHeldWeakly,
		).toBeUndefined();
		const generatorStart = coreOpcodeRegistry.require("generatorStart").effects;
		expect(generatorStart).toMatchObject({
			maySuspend: true,
			mayGc: true,
			mayThrow: true,
			callsUserCode: true,
		});
		expect(generatorStart.reads).toContain("object-property");
		const asyncStart = coreOpcodeRegistry.require("asyncStart").effects;
		expect(asyncStart).toMatchObject({
			maySuspend: false,
			mayGc: true,
			mayThrow: false,
			callsUserCode: false,
		});
		const opcodes = new CoreOpcodeRegistry();
		expect(() =>
			opcodes.define({
				opcode: "unnamedLayout",
				inputs: coreArity(0, 4),
				outputs: coreArity(1),
				effects: CORE_NO_EFFECTS,
				discardable: false,
				allocation: { keysAttribute: "", firstValueOperand: 0 },
			}),
		).toThrow(/allocation with no key attribute/);
		expect(() =>
			opcodes.define({
				opcode: "referencelessLayout",
				inputs: coreArity(0, 4),
				outputs: coreArity(0),
				effects: CORE_NO_EFFECTS,
				discardable: false,
				allocation: { keysAttribute: "keys", firstValueOperand: 0 },
			}),
		).toThrow(/without producing a reference/);
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

	it("canonicalizes a mutually recursive phi component with one external producer", () => {
		const opcodes = registry();
		const builder = new CoreFunctionBuilder(0, opcodes, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const header = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const body = builder.createBlock();
		const exit = builder.createBlock([{ representation: "boxed" }]);
		const [condition, input] = builder.block(entry).parameters.map(({ value }) => value);
		const [left, right] = builder.block(header).parameters.map(({ value }) => value);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: header, arguments: [input!, input!] },
		});
		builder.setTerminator(header, {
			kind: "branch",
			condition: condition!,
			consequent: { block: body, arguments: [] },
			alternate: { block: exit, arguments: [left!] },
		});
		builder.setTerminator(body, {
			kind: "jump",
			edge: { block: header, arguments: [right!, left!] },
		});
		builder.setTerminator(exit, {
			kind: "return",
			value: builder.block(exit).parameters[0]!.value,
		});
		const fn = builder.finish(entry);

		expect(() => verifyCoreFunction(fn, opcodes)).not.toThrow();
		const canonical = coreCanonicalValueRoots(fn, buildCoreControlFlow(fn, opcodes));
		expect(canonical.get(left!)).toBe(input);
		expect(canonical.get(right!)).toBe(input);
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

		const direct = new CoreFunctionBuilder(0, opcodes, { parameterCount: 1 });
		const directEntry = direct.createBlock([{ representation: "boxed" }]);
		const directHandler = direct.createBlock([{ role: "exception" }]);
		const [directLate] = direct.appendInstruction(directEntry, "call", [
			direct.block(directEntry).parameters[0]!.value,
		]);
		direct.setHandler(directEntry, directHandler);
		direct.setTerminator(directEntry, { kind: "return", value: directLate! });
		direct.setTerminator(directHandler, { kind: "return", value: directLate! });
		expect(() => verifyCoreFunction(direct.finish(directEntry), opcodes)).toThrow(
			/not available on exceptional flow/,
		);

		// A defining block can dominate a protected block even though an exception
		// leaves it before the definition and later reaches that block. Handler
		// arguments need instruction-exit dominance, not ordinary block dominance.
		const exceptional = new CoreFunctionBuilder(0, opcodes, { parameterCount: 1 });
		const defining = exceptional.createBlock([{ representation: "boxed" }]);
		const recovery = exceptional.createBlock([{ role: "exception" }]);
		const protectedBlock = exceptional.createBlock();
		const protectedHandler = exceptional.createBlock([
			{ role: "exception" },
			{ representation: "boxed" },
		]);
		const exceptionalInput = exceptional.block(defining).parameters[0]!.value;
		const [exceptionalLate] = exceptional.appendInstruction(defining, "call", [
			exceptionalInput,
		]);
		exceptional.setHandler(defining, recovery);
		exceptional.setTerminator(defining, {
			kind: "jump",
			edge: { block: protectedBlock, arguments: [] },
		});
		exceptional.setTerminator(recovery, {
			kind: "jump",
			edge: { block: protectedBlock, arguments: [] },
		});
		exceptional.appendInstruction(protectedBlock, "call", [exceptionalInput]);
		exceptional.setHandler(protectedBlock, protectedHandler, [exceptionalLate!]);
		exceptional.setTerminator(protectedBlock, {
			kind: "return",
			value: exceptionalInput,
		});
		exceptional.setTerminator(protectedHandler, {
			kind: "return",
			value: exceptional.block(protectedHandler).parameters[1]!.value,
		});
		expect(() => verifyCoreFunction(exceptional.finish(defining), opcodes)).toThrow(
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
