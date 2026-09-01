import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import {
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
} from "../src/compiler/core/core-ir.ts";
import type { CoreValueId } from "../src/compiler/core/core-ir.ts";
import * as coreStore from "../src/compiler/core/core-store.ts";
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
	it("checks function identities without enumerating the program", () => {
		const { program, fn } = oneFunction();
		Object.defineProperty(program, "functionIds", {
			value() {
				throw new Error("function lookup enumerated the program");
			},
		});
		expect(program.hasFunction(fn.id)).toBe(true);
		expect(program.hasFunction(1 as never)).toBe(false);
	});

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

	it("moves an operation without changing its instruction or result identity", () => {
		const { program, fn, entry, constant, copied } = oneFunction();
		const editor = CoreEditor.open(program, fn.id);
		const destination = editor.createBlock();
		editor.setTerminator(destination, { kind: "return", value: copied });
		editor.moveInstruction(1 as never, destination);
		const changes = editor.commit();

		expect([...fn.instructionIds(entry)]).toEqual([0, 2]);
		expect([...fn.instructionIds(destination)]).toEqual([1, 3]);
		expect(fn.instructionBlock(1 as never)).toBe(destination);
		expect(fn.instructionResults(1 as never)).toEqual([copied]);
		expect(fn.instructionOperands(1 as never)).toEqual([constant]);
		expect(changes.blocks).toEqual([entry, destination]);
		expect(changes.instructions).toContain(1);
		expect(changes.domains).toEqual(["body", "cfg", "specializationInputs"]);
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

	it("publishes old and new operands plus retained results for in-place rewrites", () => {
		const { program, fn, constant, copied, parameter } = oneFunction();
		const identity = [...fn.bodyInstructionIds(fn.entry)][1]!;
		const replaceOperands = CoreEditor.open(program, fn.id);
		replaceOperands.replaceOperands(identity, [parameter]);
		const operandChanges = replaceOperands.commit();

		expect(operandChanges.instructions).toEqual([identity]);
		expect(operandChanges.values).toEqual([parameter, constant, copied]);
		expect(operandChanges.edges).toEqual([]);
		expect(operandChanges.calls).toEqual([]);

		const replaceInstruction = CoreEditor.open(program, fn.id);
		replaceInstruction.replaceInstruction(identity, "identity", [constant]);
		const instructionChanges = replaceInstruction.commit();

		expect(instructionChanges.instructions).toEqual([identity]);
		expect(instructionChanges.values).toEqual([parameter, constant, copied]);
	});

	it("does not publish or version semantic no-op edits", () => {
		const { program, fn } = oneFunction();
		const instruction = [...fn.bodyInstructionIds(fn.entry)][1]!;
		const functionVersions = fn.versions;
		const programVersions = program.versions;
		const editor = CoreEditor.open(program, fn.id);
		editor.replaceOperands(instruction, fn.instructionOperands(instruction));
		editor.configureFunction({
			isGenerator: fn.isGenerator,
			isAsync: fn.isAsync,
			parameterCount: fn.parameterCount,
			metadata: fn.metadata,
		});
		editor.finishFunction(fn.entry, fn.bodyEntry);
		const changes = editor.commit();

		expect(changes).toMatchObject({
			domains: [],
			programDomains: [],
			blocks: [],
			instructions: [],
			values: [],
			facts: [],
			edges: [],
			calls: [],
			edits: 0,
		});
		expect(fn.versions).toEqual(functionVersions);
		expect(program.versions).toEqual(programVersions);
	});

	it("commits appended source metadata without invalidating semantic data", () => {
		const { program, fn } = oneFunction();
		const functionVersions = fn.versions;
		const programVersions = program.versions;
		const editor = CoreEditor.open(program, fn.id);
		const start = editor.appendSourcePositions([
			{ line: 4, column: 2 },
			{ line: 8, column: 3, inlinedFunctionIndex: 1, callerPosId: 0 },
		]);
		const changes = editor.commit();

		expect(start).toBe(0);
		expect(program.sourcePositions).toEqual([
			{ line: 4, column: 2 },
			{ line: 8, column: 3, inlinedFunctionIndex: 1, callerPosId: 0 },
		]);
		expect(changes).toMatchObject({
			domains: [],
			programDomains: ["sourcePositions"],
			edits: 1,
		});
		expect(fn.versions).toEqual(functionVersions);
		expect(program.versions).toEqual({
			...programVersions,
			sourcePositions: programVersions.sourcePositions + 1,
		});
		expect(program.versions.data).toBe(programVersions.data);
	});

	it("stores effect refinements out of line behind dense numeric instruction refs", () => {
		const program = new CoreProgram(registry());
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = builder.blockParameters(entry)[0]!.value;
		const firstFact = builder.addFact({
			kind: "first-refinement",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "first-refinement" },
			obligations: [],
			origin: "test",
		});
		const secondFact = builder.addFact({
			kind: "second-refinement",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "second-refinement" },
			obligations: [],
			origin: "test",
		});
		const [returned] = builder.appendInstruction(entry, "identity", [parameter], {
			effectRefinement: { effects: CORE_NO_EFFECTS, proof: firstFact },
		});
		builder.appendInstruction(entry, "sink", [parameter], {
			effectRefinement: { effects: CORE_NO_EFFECTS, proof: firstFact },
		});
		builder.setTerminator(entry, { kind: "return", value: returned! });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const [stable, replaced] = [...fn.bodyInstructionIds(entry)];

		expect(fn.effectRefinementCapacity).toBe(2);
		expect(fn.instructionLayout(stable!).effectRefinementRef).toBe(0);
		expect(fn.instructionLayout(replaced!).effectRefinementRef).toBe(1);
		expect(typeof fn.instructionLayout(stable!).effectRefinementRef).toBe("number");
		expect(fn.effectRefinementRecord(0)).toEqual({
			effects: CORE_NO_EFFECTS,
			proof: firstFact,
		});

		const replace = CoreEditor.open(program, fn.id);
		replace.replaceInstruction(replaced!, "sink", [parameter], {
			effectRefinement: { effects: CORE_NO_EFFECTS, proof: secondFact },
		});
		const replaceChanges = replace.commit();
		expect(replaceChanges.facts).toEqual([firstFact, secondFact]);
		expect(fn.effectRefinementCapacity).toBe(3);
		expect(fn.effectRefinementLayout(1)).toEqual({ live: false });
		expect(fn.instructionLayout(replaced!).effectRefinementRef).toBe(2);

		const clear = CoreEditor.open(program, fn.id);
		clear.clearInstructionEffectRefinement(replaced!);
		const clearChanges = clear.commit();
		expect(clearChanges.domains).toEqual([
			"memoryEffects",
			"facts",
			"specializationInputs",
		]);
		expect(clearChanges.facts).toEqual([secondFact]);
		expect(fn.instructionLayout(replaced!).effectRefinementRef).toBe(-1);
		expect(fn.effectRefinementLayout(2)).toEqual({ live: false });

		const restore = CoreEditor.open(program, fn.id);
		restore.setInstructionEffectRefinement(replaced!, {
			effects: CORE_NO_EFFECTS,
			proof: firstFact,
		});
		restore.commit();
		expect(fn.instructionLayout(replaced!).effectRefinementRef).toBe(3);

		const remove = CoreEditor.open(program, fn.id);
		remove.removeInstruction(replaced!);
		const removeChanges = remove.commit();
		expect(removeChanges.facts).toEqual([firstFact]);
		expect(fn.instructionLayout(replaced!).effectRefinementRef).toBe(-1);
		expect(fn.effectRefinementLayout(3)).toEqual({ live: false });
		expect(fn.effectRefinementCapacity).toBe(4);

		program.seal();
		verifyCoreProgram(program);
		expect(fn.instructionEffectRefinement(stable!)).toEqual({
			effects: CORE_NO_EFFECTS,
			proof: firstFact,
		});
		expect(fn.instructionLayout(stable!).effectRefinementRef).toBe(0);
		expect(() => CoreEditor.open(program, fn.id)).toThrow("sealed");
	});

	it("versions only facts and memory when a retained refinement changes", () => {
		const { program, fn, constant, copied } = oneFunction();
		const createFact = CoreEditor.open(program, fn.id);
		const fact = createFact.addFact({
			kind: "versioned-refinement",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "versioned-refinement" },
			obligations: [],
			origin: "test",
		});
		createFact.commit();
		const instruction = [...fn.bodyInstructionIds(fn.entry)][1]!;
		const before = fn.versions;
		const programBefore = program.versions;
		const set = CoreEditor.open(program, fn.id);
		set.setInstructionEffectRefinement(instruction, {
			effects: CORE_NO_EFFECTS,
			proof: fact,
		});
		const setChanges = set.commit();

		expect(setChanges.domains).toEqual([
			"memoryEffects",
			"facts",
			"specializationInputs",
		]);
		expect(setChanges.programDomains).toEqual(["facts", "specializationInputs"]);
		expect(setChanges.instructions).toEqual([instruction]);
		expect(setChanges.values).toEqual([constant, copied]);
		expect(setChanges.facts).toEqual([fact]);
		expect(fn.versions).toEqual({
			...before,
			memoryEffects: before.memoryEffects + 1,
			facts: before.facts + 1,
			specializationInputs: before.specializationInputs + 1,
		});
		expect(program.versions).toEqual({
			...programBefore,
			facts: programBefore.facts + 1,
			specializationInputs: programBefore.specializationInputs + 1,
		});

		const unchangedBefore = fn.versions;
		const unchanged = CoreEditor.open(program, fn.id);
		unchanged.setInstructionEffectRefinement(
			instruction,
			fn.instructionEffectRefinement(instruction)!,
		);
		const unchangedChanges = unchanged.commit();
		expect(unchangedChanges.edits).toBe(0);
		expect(unchangedChanges.domains).toEqual([]);
		expect(fn.versions).toEqual(unchangedBefore);

		const clear = CoreEditor.open(program, fn.id);
		clear.clearInstructionEffectRefinement(instruction);
		const clearChanges = clear.commit();
		expect(clearChanges.domains).toEqual(setChanges.domains);
		expect(clearChanges.facts).toEqual([fact]);
		expect(fn.instructionEffectRefinement(instruction)).toBeUndefined();

		const clearedBefore = fn.versions;
		const capacityBefore = fn.effectRefinementCapacity;
		const clearAgain = CoreEditor.open(program, fn.id);
		clearAgain.clearInstructionEffectRefinement(instruction);
		const clearAgainChanges = clearAgain.commit();
		expect(clearAgainChanges.edits).toBe(0);
		expect(fn.effectRefinementCapacity).toBe(capacityBefore);
		expect(fn.versions).toEqual(clearedBefore);
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

	it("replaces a fact in place without invalidating the function body or CFG", () => {
		const { program, fn, parameter } = oneFunction();
		const create = CoreEditor.open(program, fn.id);
		const fact = create.addFact({
			kind: "test-range",
			value: [0, 10],
			claims: [
				{
					kind: "range",
					subject: parameter,
					minimum: 0,
					maximum: 10,
					integer: false,
					mayBeNaN: false,
					mayBeNegativeZero: false,
				},
			],
			validity: { kind: "summary", digest: "test-range:wide" },
			obligations: [],
			origin: "test",
		});
		create.commit();
		const functionBefore = fn.versions;
		const programBefore = program.versions;

		const replace = CoreEditor.open(program, fn.id);
		replace.replaceFact(fact, {
			kind: "test-range",
			value: [1, 3],
			claims: [
				{
					kind: "range",
					subject: parameter,
					minimum: 1,
					maximum: 3,
					integer: true,
					mayBeNaN: false,
					mayBeNegativeZero: false,
				},
			],
			validity: { kind: "summary", digest: "test-range:narrow" },
			obligations: [],
			origin: "test",
		});
		const changes = replace.commit();

		expect(fn.fact(fact)).toMatchObject({
			id: fact,
			value: [1, 3],
			validity: { kind: "summary", digest: "test-range:narrow" },
		});
		expect(changes).toMatchObject({
			domains: ["facts", "specializationInputs"],
			programDomains: ["facts", "specializationInputs"],
			facts: [fact],
			edits: 1,
		});
		expect(fn.versions).toEqual({
			...functionBefore,
			facts: functionBefore.facts + 1,
			specializationInputs: functionBefore.specializationInputs + 1,
		});
		expect(program.versions).toEqual({
			...programBefore,
			facts: programBefore.facts + 1,
			specializationInputs: programBefore.specializationInputs + 1,
		});
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

	it("reports every contained domain, call site, and edge when removing a block", () => {
		const callRegistry = registry();
		callRegistry.define({
			opcode: "effectful-call",
			inputs: coreArity(1),
			outputs: coreArity(1),
			effects: {
				reads: ["host"],
				writes: ["host"],
				mayThrow: true,
				maySuspend: false,
				mayGc: true,
				callsUserCode: true,
			},
			discardable: false,
			callTransfer: {
				calleeOperand: 0,
				result: "construct-completion",
				invocation: "construct",
				arguments: { kind: "positional", firstOperand: 1 },
			},
		});
		const program = new CoreProgram(callRegistry);
		const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
		const entry = builder.createBlock([{ representation: "boxed" }]);
		const parameter = builder.blockParameters(entry)[0]!.value;
		const removed = builder.createBlock([{ representation: "i32" }]);
		const removedParameter = builder.blockParameters(removed)[0]!.value;
		const fact = builder.addFact({
			kind: "test-effect",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "test-effect" },
			obligations: [],
			origin: "test",
		});
		const [callResult] = builder.appendInstruction(
			removed,
			"effectful-call",
			[parameter],
			{
				outputRepresentations: ["scalarized-object"],
				effectRefinement: { effects: CORE_NO_EFFECTS, proof: fact },
			},
		);
		builder.setHandler(removed, entry, [parameter]);
		builder.setTerminator(removed, {
			kind: "jump",
			edge: { block: entry, arguments: [] },
		});
		builder.setTerminator(entry, { kind: "return", value: parameter });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const call = [...fn.bodyInstructionIds(removed)][0]!;

		const editor = CoreEditor.open(program, fn.id);
		editor.removeBlock(removed);
		const changes = editor.commit();

		expect(changes.domains).toEqual([
			"body",
			"specializationInputs",
			"calls",
			"memoryEffects",
			"facts",
			"cfg",
			"exceptionFlow",
		]);
		expect(changes.programDomains).toEqual(["specializationInputs", "calls", "facts"]);
		expect(changes.calls).toEqual([call]);
		expect(changes.facts).toEqual([fact]);
		expect(changes.values).toEqual([parameter, removedParameter, callResult!]);
		expect(changes.edges).toEqual([
			{ kind: "control-flow", source: removed, target: entry },
			{ kind: "exception", source: removed, target: entry },
		]);
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

	it("does not export the store mutation capability", () => {
		expect(coreStore).not.toHaveProperty("CORE_STORE_MUTATION");
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
