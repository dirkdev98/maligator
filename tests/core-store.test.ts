import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import {
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "../src/compiler/core/core-ir.ts";
import type { CoreValueId } from "../src/compiler/core/core-ir.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";

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
		opcode: "identity",
		inputs: coreArity(1),
		outputs: coreArity(1),
		effects: CORE_NO_EFFECTS,
		discardable: true,
	});
	registry.define({
		opcode: "sink",
		inputs: coreArity(1),
		outputs: coreArity(0),
		effects: CORE_NO_EFFECTS,
		discardable: false,
	});
	return registry;
}

function oneFunction(program = new CoreProgram(registry())) {
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const entry = builder.createBlock([{ representation: "boxed" }]);
	const parameter = builder.blockParameters(entry)[0]!.value;
	const [constant] = builder.appendInstruction(entry, "constant", [], {
		outputRepresentations: ["i32"],
	});
	const [copied] = builder.appendInstruction(entry, "identity", [constant!], {
		outputRepresentations: ["i32"],
	});
	builder.setTerminator(entry, { kind: "return", value: copied! });
	const finished = builder.finish(entry);
	return {
		program,
		fn: program.function(finished.function),
		entry,
		parameter,
		constant: constant!,
		copied: copied!,
		changes: finished.changes,
	};
}

describe("Core store", () => {
	it("allocates stable monotonic identities and preserves linked instruction order", () => {
		const { fn, entry, constant, copied } = oneFunction();
		expect(fn.id).toBe(0);
		expect(entry).toBe(0);
		expect(constant).toBe(1);
		expect(copied).toBe(2);
		expect([...fn.instructionIds(entry)]).toEqual([0, 1, 2]);
		expect([...fn.bodyInstructionIds(entry)]).toEqual([0, 1]);
		expect(fn.instructionOpcodeName(0 as never)).toBe("constant");
		expect(fn.instructionPrevious(1 as never)).toBe(0);
		expect(fn.instructionNext(1 as never)).toBe(2);
	});

	it("leaves tombstones and never reuses an instruction identity", () => {
		const { program, fn, entry, copied } = oneFunction();
		const editor = CoreEditor.open(program, fn.id);
		const [originalConstant, identity] = [...fn.bodyInstructionIds(entry)];
		editor.replaceOperands(identity!, [fn.parameters[0]!]);
		editor.removeInstruction(originalConstant!);
		const inserted = editor.insertInstruction(entry, fn.blockTerminator(entry), "sink", [
			copied,
		]);
		editor.commit();
		expect(originalConstant).toBe(0);
		expect(inserted.instruction).toBe(3);
		expect(fn.isInstructionLive(originalConstant!)).toBe(false);
		expect([...fn.instructionIds(entry)]).toEqual([1, 3, 2]);
	});

	it("maintains exact definitions and uses when operand ranges are replaced", () => {
		const { program, fn, constant, copied, parameter } = oneFunction();
		const identity = [...fn.bodyInstructionIds(fn.entry)][1]!;
		expect(fn.valueDefinition(constant)).toEqual({
			kind: "instruction",
			instruction: 0,
			index: 0,
		});
		expect(fn.valueDefinition(parameter)).toEqual({
			kind: "block-parameter",
			block: 0,
			index: 0,
		});
		expect([...fn.uses(constant)]).toEqual([{ instruction: identity, operand: 0 }]);
		expect([...fn.uses(copied)]).toEqual([{ instruction: 2, operand: 0 }]);

		const editor = CoreEditor.open(program, fn.id);
		editor.replaceOperands(identity, [parameter]);
		editor.commit();
		expect([...fn.uses(constant)]).toEqual([]);
		expect([...fn.uses(parameter)]).toEqual([{ instruction: identity, operand: 0 }]);
		expect(fn.valueUseCount(constant)).toBe(0);
		expect(fn.valueUseCount(parameter)).toBe(1);
	});

	it("increments only selected version domains once per commit", () => {
		const first = oneFunction();
		const second = oneFunction(first.program);
		const firstBefore = first.fn.versions;
		const secondBefore = second.fn.versions;
		const editor = CoreEditor.open(first.program, first.fn.id);
		editor.setValueRepresentation(first.constant, "f64");
		editor.setValueRepresentation(first.copied, "f64");
		const changes = editor.commit();

		expect(changes.domains).toEqual(["representations", "specializationInputs"]);
		expect(changes.values).toEqual([first.constant, first.copied]);
		expect(changes.edits).toBe(2);
		expect(first.fn.versions).toEqual({
			...firstBefore,
			representations: firstBefore.representations + 1,
			specializationInputs: firstBefore.specializationInputs + 1,
		});
		expect(second.fn.versions).toEqual(secondBefore);
	});

	it("reports one precise change set for an initial construction commit", () => {
		const { changes } = oneFunction();
		expect(changes.function).toBe(0);
		expect(changes.programDomains).toContain("functions");
		expect(changes.blocks).toEqual([0]);
		expect(changes.instructions).toEqual([0, 1, 2]);
		expect(changes.values).toEqual([0, 1, 2]);
		expect(changes.edits).toBeGreaterThan(0);
	});

	it("keeps function identities stable when another function is added", () => {
		const first = oneFunction();
		const second = oneFunction(first.program);
		expect([...first.program.functionIds()]).toEqual([0, 1]);
		expect(first.program.function(first.fn.id)).toBe(first.fn);
		expect(second.fn.id).toBe(1);
	});

	it("rejects overlapping editors and every mutation after sealing", () => {
		const { program, fn } = oneFunction();
		const editor = CoreEditor.open(program, fn.id);
		expect(() => CoreEditor.open(program, fn.id)).toThrow("already has an editor");
		editor.commit();
		const sealed = program.seal();
		expect(sealed).toBe(program);
		expect(() => CoreEditor.open(program, fn.id)).toThrow("sealed");
		expect(() => CoreEditor.createFunction(program)).toThrow("sealed");
	});

	it("does not expose mutable operand or result storage", () => {
		const { fn, constant } = oneFunction();
		const identity = [...fn.bodyInstructionIds(fn.entry)][1]!;
		const operands = fn.instructionOperands(identity) as Array<CoreValueId>;
		operands[0] = 99 as CoreValueId;
		expect(fn.instructionOperands(identity)).toEqual([constant]);
	});

	it("keeps every reader result outside the mutation boundary", () => {
		const { program, fn } = oneFunction();
		const identity = [...fn.bodyInstructionIds(fn.entry)][1]!;
		const parameters = fn.parameters as Array<CoreValueId>;
		parameters[0] = 99 as CoreValueId;
		expect(fn.parameters).toEqual([0]);
		expect(() => {
			(fn.instructionAttributes(identity) as Record<string, unknown>).forged = true;
		}).toThrow();
		CoreEditor.configureProgram(program, { stringConstants: [[65]] });
		expect(() => {
			(program.stringConstants[0] as Array<number>)[0] = 66;
		}).toThrow();
		expect(program.stringConstants).toEqual([[65]]);
	});
});
