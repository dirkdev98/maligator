import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import {
	CORE_NO_EFFECTS,
	CoreOpcodeRegistry,
	coreArity,
	formatCoreFunction,
} from "../src/compiler/core/core-ir.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreImmediate,
	CoreTerminatorPayload,
	CoreValueId,
} from "../src/compiler/core/core-ir.ts";
import * as coreStore from "../src/compiler/core/core-store.ts";
import { CoreProgram } from "../src/compiler/core/core-store.ts";
import {
	inspectCoreBlockHandler,
	inspectCoreBlockParameters,
	inspectCoreEffectRefinementLayout,
	inspectCoreFunctionParameters,
	inspectCoreInstructionLayout,
	inspectCoreInstructionOperands,
	inspectCoreInstructionResults,
	inspectCoreTerminatorPayload,
	inspectCoreUses,
	inspectCoreValueDefinition,
} from "./helpers/core-inspection.ts";

function registry(): CoreOpcodeRegistry {
	const registry = new CoreOpcodeRegistry();
	registry.define({
		opcode: "constant",
		inputs: coreArity(0),
		outputs: coreArity(1),
		effects: CORE_NO_EFFECTS,
		discardable: true,
		attributeRelocations: [],
	});
	registry.define({
		opcode: "identity",
		inputs: coreArity(1),
		outputs: coreArity(1),
		effects: CORE_NO_EFFECTS,
		discardable: true,
		attributeRelocations: [{ path: ["anchor"], kind: "value", cardinality: "one" }],
	});
	registry.define({
		opcode: "sink",
		inputs: coreArity(1),
		outputs: coreArity(0),
		effects: CORE_NO_EFFECTS,
		discardable: false,
		attributeRelocations: [],
	});
	return registry;
}

function oneFunction(program = new CoreProgram(registry())) {
	const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
	const entry = builder.createBlock([{ representation: "boxed" }]);
	const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
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

function terminatorFixture(kind: CoreTerminatorPayload["kind"]) {
	const program = new CoreProgram(registry());
	const builder = new CoreFunctionBuilder(program, { parameterCount: 3 });
	const entry = builder.createBlock([
		{ representation: "boxed" },
		{ representation: "boxed" },
		{ representation: "boxed" },
	]);
	const [condition, first, second] = inspectCoreBlockParameters(builder, entry).map(
		({ value }) => value,
	) as [CoreValueId, CoreValueId, CoreValueId];
	let expected: CoreTerminatorPayload;

	switch (kind) {
		case "jump": {
			const target = builder.createBlock([
				{ representation: "boxed" },
				{ representation: "boxed" },
			]);
			builder.setTerminator(target, {
				kind: "return",
				value: inspectCoreBlockParameters(builder, target)[0]!.value,
			});
			expected = { kind, edge: { block: target, arguments: [first, second] } };
			builder.setTerminator(entry, expected);
			break;
		}
		case "branch": {
			const consequent = builder.createBlock([{ representation: "boxed" }]);
			const alternate = builder.createBlock([
				{ representation: "boxed" },
				{ representation: "boxed" },
			]);
			builder.setTerminator(consequent, {
				kind: "return",
				value: inspectCoreBlockParameters(builder, consequent)[0]!.value,
			});
			builder.setTerminator(alternate, {
				kind: "return",
				value: inspectCoreBlockParameters(builder, alternate)[0]!.value,
			});
			expected = {
				kind,
				condition,
				consequent: { block: consequent, arguments: [first] },
				alternate: { block: alternate, arguments: [first, second] },
			};
			builder.setTerminator(entry, expected);
			break;
		}
		case "guard": {
			const success = builder.createBlock([{ representation: "boxed" }]);
			const fallback = builder.createBlock([
				{ representation: "boxed" },
				{ representation: "boxed" },
			]);
			builder.setTerminator(success, {
				kind: "return",
				value: inspectCoreBlockParameters(builder, success)[0]!.value,
			});
			builder.setTerminator(fallback, {
				kind: "return",
				value: inspectCoreBlockParameters(builder, fallback)[0]!.value,
			});
			const fact = builder.setGuardTerminator(entry, {
				condition,
				success: { block: success, arguments: [first] },
				fallback: { block: fallback, arguments: [first, second] },
				fact: {
					kind: "terminator-storage",
					value: true,
					claims: [],
					origin: "test",
				},
			});
			expected = {
				kind,
				condition,
				fact,
				success: { block: success, arguments: [first] },
				fallback: { block: fallback, arguments: [first, second] },
			};
			break;
		}
		case "switch": {
			const firstCase = builder.createBlock([{ representation: "boxed" }]);
			const secondCase = builder.createBlock([
				{ representation: "boxed" },
				{ representation: "boxed" },
			]);
			const defaultBlock = builder.createBlock();
			builder.setTerminator(firstCase, {
				kind: "return",
				value: inspectCoreBlockParameters(builder, firstCase)[0]!.value,
			});
			builder.setTerminator(secondCase, {
				kind: "return",
				value: inspectCoreBlockParameters(builder, secondCase)[0]!.value,
			});
			builder.setTerminator(defaultBlock, { kind: "unreachable" });
			expected = {
				kind,
				discriminant: condition,
				cases: [
					{
						value: { kind: "number", value: 1 },
						edge: { block: firstCase, arguments: [first] },
					},
					{
						value: { kind: "number", value: 2 },
						edge: { block: secondCase, arguments: [first, second] },
					},
				],
				default: { block: defaultBlock, arguments: [] },
			};
			builder.setTerminator(entry, expected);
			break;
		}
		case "return":
		case "throw":
			expected = { kind, value: first };
			builder.setTerminator(entry, expected);
			break;
		case "unreachable":
			expected = { kind };
			builder.setTerminator(entry, expected);
			break;
	}

	const finished = builder.finish(entry);
	const fn = program.function(finished.function);
	return {
		program,
		fn,
		entry,
		condition,
		first,
		second,
		instruction: fn.blockTerminator(entry),
		expected,
	};
}

function payloadOperands(payload: CoreTerminatorPayload): ReadonlyArray<CoreValueId> {
	switch (payload.kind) {
		case "jump":
			return payload.edge.arguments;
		case "branch":
			return [
				payload.condition,
				...payload.consequent.arguments,
				...payload.alternate.arguments,
			];
		case "guard":
			return [
				payload.condition,
				...payload.success.arguments,
				...payload.fallback.arguments,
			];
		case "switch":
			return [
				payload.discriminant,
				...payload.cases.flatMap(({ edge }) => edge.arguments),
				...payload.default.arguments,
			];
		case "return":
		case "throw":
			return [payload.value];
		case "unreachable":
			return [];
	}
}

function payloadEdges(payload: CoreTerminatorPayload): ReadonlyArray<{
	readonly edge: CoreEdge;
	readonly caseValue?: CoreImmediate;
}> {
	switch (payload.kind) {
		case "jump":
			return [{ edge: payload.edge }];
		case "branch":
			return [{ edge: payload.consequent }, { edge: payload.alternate }];
		case "guard":
			return [{ edge: payload.success }, { edge: payload.fallback }];
		case "switch":
			return [
				...payload.cases.map(({ value, edge }) => ({ caseValue: value, edge })),
				{ edge: payload.default },
			];
		case "return":
		case "throw":
		case "unreachable":
			return [];
	}
}

function mutateTerminatorSnapshot(payload: CoreTerminatorPayload): void {
	const mutateEdge = (edge: CoreEdge) => {
		(edge as { block: CoreBlockId }).block = 99 as CoreBlockId;
		if (edge.arguments.length > 0) {
			(edge.arguments as Array<CoreValueId>)[0] = 99 as CoreValueId;
		}
	};
	switch (payload.kind) {
		case "jump":
			mutateEdge(payload.edge);
			break;
		case "branch":
			(payload as { condition: CoreValueId }).condition = 99 as CoreValueId;
			mutateEdge(payload.consequent);
			mutateEdge(payload.alternate);
			break;
		case "guard":
			(payload as { condition: CoreValueId }).condition = 99 as CoreValueId;
			mutateEdge(payload.success);
			mutateEdge(payload.fallback);
			break;
		case "switch":
			(payload as { discriminant: CoreValueId }).discriminant = 99 as CoreValueId;
			mutateEdge(payload.cases[0]!.edge);
			(payload.cases[0]!.value as { value: number }).value = 99;
			mutateEdge(payload.default);
			break;
		case "return":
		case "throw":
			(payload as { value: CoreValueId }).value = 99 as CoreValueId;
			break;
		case "unreachable":
			(payload as { kind: string }).kind = "return";
			break;
	}
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

	it("reuses stable function traversal snapshots between edits", () => {
		const { program, fn } = oneFunction();
		const blocks = fn.blockIds();
		const instructions = fn.instructionIds();

		expect(fn.blockIds()).toBe(blocks);
		expect(fn.instructionIds()).toBe(instructions);

		const editor = CoreEditor.open(program, fn.id);
		const added = editor.createBlock();
		editor.setTerminator(added, { kind: "unreachable" });
		editor.commit();

		expect(fn.blockIds()).not.toBe(blocks);
		expect(fn.instructionIds()).not.toBe(instructions);
		expect([...fn.blockIds()]).toContain(added);
	});

	it.each([
		"jump",
		"branch",
		"guard",
		"switch",
		"return",
		"throw",
		"unreachable",
	] as const)("reconstructs %s inputs from one dense operand range", (kind) => {
		const { program, fn, instruction, expected } = terminatorFixture(kind);
		const operands = payloadOperands(expected);
		const edges = payloadEdges(expected);

		expect(inspectCoreTerminatorPayload(fn, instruction)).toEqual(expected);
		expect(inspectCoreInstructionOperands(fn, instruction)).toEqual(operands);
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const edgeStart = fn.kernel.terminatorEdgeStart(instruction);
		expect(fn.kernel.terminatorEdgeCount(instruction)).toBe(edges.length);
		expect(fn.kernel.terminatorFact(instruction)).toBe(
			expected.kind === "guard" ? expected.fact : undefined,
		);
		let argumentStart =
			expected.kind === "branch" ||
			expected.kind === "guard" ||
			expected.kind === "switch"
				? operandStart + 1
				: operandStart;
		for (const [offset, { edge, caseValue }] of edges.entries()) {
			const row = edgeStart + offset;
			expect(fn.kernel.terminatorEdgeBlock(row)).toBe(edge.block);
			expect(fn.kernel.terminatorEdgeArgumentStart(row)).toBe(argumentStart);
			expect(fn.kernel.terminatorEdgeArgumentCount(row)).toBe(edge.arguments.length);
			expect(fn.kernel.terminatorEdgeCaseValue(row)).toEqual(caseValue);
			for (const [argument, value] of edge.arguments.entries()) {
				expect(fn.kernel.operandAt(argumentStart + argument)).toBe(value);
			}
			argumentStart += edge.arguments.length;
		}
		for (const value of new Set(operands)) {
			const expectedUses = operands
				.flatMap((candidate, operand) =>
					candidate === value ? [{ instruction, operand }] : [],
				)
				.reverse();
			expect([...inspectCoreUses(fn, value)]).toEqual(expectedUses);
			expect(fn.valueUseCount(value)).toBe(expectedUses.length);
		}

		const operandSnapshot = inspectCoreInstructionOperands(
			fn,
			instruction,
		) as Array<CoreValueId>;
		if (operandSnapshot.length > 0) {
			expect(() => {
				operandSnapshot[0] = 99 as CoreValueId;
			}).toThrow(TypeError);
		}
		const payloadSnapshot = inspectCoreTerminatorPayload(fn, instruction);
		expect(() => mutateTerminatorSnapshot(payloadSnapshot)).toThrow(TypeError);
		expect(inspectCoreInstructionOperands(fn, instruction)).toEqual(operands);
		expect(inspectCoreTerminatorPayload(fn, instruction)).toEqual(expected);
		expect(inspectCoreTerminatorPayload(fn, instruction)).not.toBe(payloadSnapshot);

		program.seal();
		expect(() => verifyCoreProgram(program)).not.toThrow();
	});

	it("keeps terminator shape, operands, uses, and changed edges exact through edits", () => {
		const { program, fn, entry, condition, first, second, instruction, expected } =
			terminatorFixture("branch");
		if (expected.kind !== "branch") throw new Error("expected branch fixture");
		const initialLayout = inspectCoreInstructionLayout(fn, instruction);
		const redirect = CoreEditor.open(program, fn.id);
		const redirected = redirect.createBlock([{ representation: "boxed" }]);
		const redirectedParameter = inspectCoreBlockParameters(fn, redirected)[0]!.value;
		redirect.setTerminator(redirected, {
			kind: "return",
			value: redirectedParameter,
		});
		redirect.redirectEdge(entry, expected.consequent.block, {
			block: redirected,
			arguments: [second],
		});
		const redirectChanges = redirect.commit();
		const redirectedLayout = inspectCoreInstructionLayout(fn, instruction);

		expect(fn.blockTerminator(entry)).toBe(instruction);
		expect(inspectCoreTerminatorPayload(fn, instruction)).toEqual({
			...expected,
			consequent: { block: redirected, arguments: [second] },
		});
		expect(inspectCoreInstructionOperands(fn, instruction)).toEqual([
			condition,
			second,
			first,
			second,
		]);
		expect([...inspectCoreUses(fn, condition)]).toEqual([{ instruction, operand: 0 }]);
		expect([...inspectCoreUses(fn, first)]).toEqual([{ instruction, operand: 2 }]);
		expect([...inspectCoreUses(fn, second)]).toEqual([
			{ instruction, operand: 3 },
			{ instruction, operand: 1 },
		]);
		expect(redirectedLayout.operandStart).toBe(initialLayout.operandStart);
		expect(redirectedLayout.operandCount).toBe(initialLayout.operandCount);
		expect(redirectChanges.edges).toEqual([
			{ kind: "control-flow", source: entry, target: expected.consequent.block },
			{ kind: "control-flow", source: entry, target: expected.alternate.block },
			{ kind: "control-flow", source: entry, target: redirected },
		]);

		const replace = CoreEditor.open(program, fn.id);
		replace.replaceTerminator(entry, { kind: "throw", value: first });
		const replaceChanges = replace.commit();

		expect(fn.blockTerminator(entry)).toBe(instruction);
		expect(inspectCoreTerminatorPayload(fn, instruction)).toEqual({
			kind: "throw",
			value: first,
		});
		expect(inspectCoreInstructionOperands(fn, instruction)).toEqual([first]);
		expect([...inspectCoreUses(fn, condition)]).toEqual([]);
		expect([...inspectCoreUses(fn, first)]).toEqual([{ instruction, operand: 0 }]);
		expect([...inspectCoreUses(fn, second)]).toEqual([]);
		expect(replaceChanges.edges).toEqual([
			{ kind: "control-flow", source: entry, target: expected.alternate.block },
			{ kind: "control-flow", source: entry, target: redirected },
		]);
		program.seal();
		expect(() => verifyCoreProgram(program)).not.toThrow();
	});

	it("reconstructs a terminator solely from dense operands after replacing value uses", () => {
		const { program, fn, entry, condition, first, second, instruction, expected } =
			terminatorFixture("branch");
		if (expected.kind !== "branch") throw new Error("expected branch fixture");
		const editor = CoreEditor.open(program, fn.id);
		editor.replaceValueUses(first, second);
		const changes = editor.commit();

		expect(inspectCoreTerminatorPayload(fn, instruction)).toEqual({
			...expected,
			consequent: { ...expected.consequent, arguments: [second] },
			alternate: { ...expected.alternate, arguments: [second, second] },
		});
		expect(inspectCoreInstructionOperands(fn, instruction)).toEqual([
			condition,
			second,
			second,
			second,
		]);
		expect([...inspectCoreUses(fn, first)]).toEqual([]);
		expect([...inspectCoreUses(fn, second)]).toEqual([
			{ instruction, operand: 3 },
			{ instruction, operand: 2 },
			{ instruction, operand: 1 },
		]);
		expect(changes.instructions).toEqual([instruction]);
		expect(changes.values).toEqual([condition, first, second]);
		expect(changes.edges).toEqual([
			{ kind: "control-flow", source: entry, target: expected.consequent.block },
			{ kind: "control-flow", source: entry, target: expected.alternate.block },
		]);
		program.seal();
		expect(() => verifyCoreProgram(program)).not.toThrow();
	});

	it("replaces several values in one dense-operand edit", () => {
		const { program, fn, condition, first, second, instruction, expected } =
			terminatorFixture("branch");
		if (expected.kind !== "branch") throw new Error("expected branch fixture");
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const operandCapacity = fn.operandCapacity;
		const useCapacity = fn.useCapacity;
		const editor = CoreEditor.open(program, fn.id);
		editor.replaceValueUsesMany(
			new Map([
				[condition, first],
				[first, second],
			]),
		);
		const changes = editor.commit();

		expect(inspectCoreTerminatorPayload(fn, instruction)).toEqual({
			...expected,
			condition: first,
			consequent: { ...expected.consequent, arguments: [second] },
			alternate: { ...expected.alternate, arguments: [second, second] },
		});
		expect(changes.edits).toBe(1);
		expect(fn.kernel.instructionOperandStart(instruction)).toBe(operandStart);
		expect(fn.operandCapacity).toBe(operandCapacity);
		expect(fn.useCapacity).toBe(useCapacity);
		program.seal();
		expect(() => verifyCoreProgram(program)).not.toThrow();
	});

	it("lets the verifier reject a replacement whose dense edge arguments are invalid", () => {
		const { program, fn, entry, instruction, expected } = terminatorFixture("jump");
		if (expected.kind !== "jump") throw new Error("expected jump fixture");
		const editor = CoreEditor.open(program, fn.id);
		editor.replaceTerminator(entry, {
			kind: "jump",
			edge: { block: expected.edge.block, arguments: [] },
		});
		editor.commit();

		expect(inspectCoreTerminatorPayload(fn, instruction)).toEqual({
			kind: "jump",
			edge: { block: expected.edge.block, arguments: [] },
		});
		expect(inspectCoreInstructionOperands(fn, instruction)).toEqual([]);
		for (const value of expected.edge.arguments)
			expect([...inspectCoreUses(fn, value)]).toEqual([]);
		program.seal();
		expect(() => verifyCoreProgram(program)).toThrow(
			/ordinary edge b0 -> b1 passes 0 values to 2 parameters/,
		);
	});

	it("leaves tombstones and never reuses an instruction identity", () => {
		const { program, fn, entry, copied } = oneFunction();
		const editor = CoreEditor.open(program, fn.id);
		const [originalConstant, identity] = [...fn.bodyInstructionIds(entry)];
		editor.replaceOperands(identity!, [inspectCoreFunctionParameters(fn)[0]!]);
		editor.removeInstruction(originalConstant!);
		const inserted = editor.insertInstruction(entry, fn.blockTerminator(entry), "sink", [
			copied,
		]);
		editor.commit();
		expect(originalConstant).toBe(0);
		expect(inserted.instruction).toBe(3);
		expect(fn.isInstructionLive(originalConstant!)).toBe(false);
		expect([...fn.instructionIds(entry)]).toEqual([1, 3, 2]);
		expect(new Set(fn.valueIds())).toEqual(
			new Set(
				Array.from({ length: fn.valueCapacity }, (_, value) => value as never).filter(
					(value) => fn.isValueLive(value),
				),
			),
		);
	});

	it("removes several block parameters in one stable batch", () => {
		const program = new CoreProgram(registry());
		const builder = new CoreFunctionBuilder(program, { parameterCount: 4 });
		const entry = builder.createBlock(Array.from({ length: 4 }, () => ({})));
		const arguments_ = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		);
		const target = builder.createBlock(Array.from({ length: 4 }, () => ({})));
		const parameters = inspectCoreBlockParameters(builder, target).map(
			({ value }) => value,
		);
		builder.setTerminator(entry, {
			kind: "jump",
			edge: { block: target, arguments: arguments_ },
		});
		builder.setTerminator(target, { kind: "return", value: parameters[0]! });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const editor = CoreEditor.open(program, fn.id);
		editor.replaceTerminator(entry, {
			kind: "jump",
			edge: { block: target, arguments: [arguments_[0]!, arguments_[2]!] },
		});
		editor.removeBlockParameters(target, [3, 1]);
		expect(editor.pendingEdits).toBe(3);
		editor.commit();
		verifyCoreProgram(program);

		expect(inspectCoreBlockParameters(fn, target).map(({ value }) => value)).toEqual([
			parameters[0],
			parameters[2],
		]);
		expect(fn.isValueLive(parameters[1]!)).toBe(false);
		expect(fn.isValueLive(parameters[3]!)).toBe(false);
		expect(inspectCoreValueDefinition(fn, parameters[2]!)).toMatchObject({ index: 1 });
	});

	it("densely finalizes construction storage exactly once", () => {
		const program = new CoreProgram(registry());
		const builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const entry = builder.createBlock([
			{ representation: "boxed" },
			{ representation: "boxed" },
		]);
		const [condition, argument] = inspectCoreBlockParameters(builder, entry).map(
			({ value }) => value,
		) as [CoreValueId, CoreValueId];
		const removed = builder.createBlock([{ representation: "i32" }]);
		const success = builder.createBlock([{ representation: "boxed" }]);
		const fallback = builder.createBlock([{ representation: "boxed" }]);
		const handler = builder.createBlock([
			{ representation: "boxed", role: "exception" },
			{ representation: "boxed" },
		]);
		const successParameter = inspectCoreBlockParameters(builder, success)[0]!.value;
		const fallbackParameter = inspectCoreBlockParameters(builder, fallback)[0]!.value;
		const handlerParameter = inspectCoreBlockParameters(builder, handler)[1]!.value;
		const removedFact = builder.addFact({
			kind: "removed",
			value: null,
			claims: [],
			validity: { kind: "asserted", source: "test" },
			obligations: [],
			origin: "test",
		});
		const proof = builder.addFact({
			kind: "relocated",
			value: true,
			claims: [],
			validity: { kind: "summary", digest: "relocated" },
			obligations: [],
			origin: "test",
		});
		const [result] = builder.appendInstruction(success, "identity", [successParameter], {
			attributes: { anchor: successParameter },
			effectRefinement: { effects: CORE_NO_EFFECTS, proof },
		});
		builder.setHandler(success, handler, [successParameter]);
		const guard = builder.setTerminator(entry, {
			kind: "guard",
			condition,
			fact: proof,
			success: { block: success, arguments: [argument] },
			fallback: { block: fallback, arguments: [argument] },
		});
		builder.setTerminator(removed, { kind: "unreachable" });
		builder.setTerminator(success, { kind: "return", value: result! });
		builder.setTerminator(fallback, { kind: "return", value: fallbackParameter });
		builder.setTerminator(handler, { kind: "return", value: handlerParameter });
		const finished = builder.finish(entry);
		const fn = program.function(finished.function);
		const operation = [...fn.bodyInstructionIds(success)][0]!;
		const mutate = CoreEditor.open(program, fn.id);
		mutate.replaceFact(proof, {
			kind: "relocated",
			value: true,
			claims: [
				{ kind: "identity", subject: successParameter, identities: ["argument"] },
				{ kind: "effect", instruction: operation, effects: CORE_NO_EFFECTS },
			],
			validity: { kind: "guard", instruction: guard },
			obligations: [{ kind: "guard", instruction: guard }],
			origin: "test",
		});
		mutate.removeFact(removedFact);
		mutate.removeBlock(removed);
		mutate.appendBlockParameter(success, { representation: "i32" });
		mutate.removeBlockParameter(success, 1);
		mutate.commit();
		verifyCoreProgram(program);

		const oldFunction = fn;
		const oldCapacities = {
			blocks: fn.blockCapacity,
			instructions: fn.instructionCapacity,
			values: fn.valueCapacity,
			facts: fn.factCapacity,
			blockParameters: fn.blockParameterCapacity,
		};
		expect(program.finalizeConstructionGeneration()).toBe(true);
		const dense = program.function(finished.function);
		const live = dense.liveStorageCounts();

		expect(program.generation).toBe(1);
		expect(oldFunction.generation).toBe(0);
		expect(dense.generation).toBe(1);
		expect(dense.id).toBe(oldFunction.id);
		expect(dense).not.toBe(oldFunction);
		expect(() => oldFunction.instructionKind(operation)).toThrow("retired generation 0");
		expect([...dense.blockIds()]).toEqual(
			Array.from({ length: live.blocks }, (_, id) => id),
		);
		expect([...dense.instructionIds()]).toEqual(
			Array.from({ length: live.instructions }, (_, id) => id),
		);
		expect([...dense.valueIds()]).toEqual(
			Array.from({ length: live.values }, (_, id) => id),
		);
		expect([...dense.factIds()]).toEqual(
			Array.from({ length: live.facts }, (_, id) => id),
		);
		expect({
			blocks: dense.blockCapacity,
			instructions: dense.instructionCapacity,
			values: dense.valueCapacity,
			uses: dense.useCapacity,
			operands: dense.operandCapacity,
			blockParameters: dense.blockParameterCapacity,
			terminatorEdges: dense.terminatorEdgeCapacity,
			handlerArguments: dense.handlerArgumentCapacity,
			facts: dense.factCapacity,
			effectRefinements: dense.effectRefinementCapacity,
		}).toEqual({
			blocks: live.blocks,
			instructions: live.instructions,
			values: live.values,
			uses: live.uses,
			operands: live.operands,
			blockParameters: live.blockParameters,
			terminatorEdges: live.terminatorEdges,
			handlerArguments: live.handlerArguments,
			facts: live.facts,
			effectRefinements: live.effectRefinements,
		});
		expect(dense.storageStatistics()).toEqual({
			abandonedOperands: 0,
			abandonedParameters: 0,
		});
		expect(oldCapacities.blocks).toBeGreaterThan(dense.blockCapacity);
		expect(oldCapacities.instructions).toBeGreaterThan(dense.instructionCapacity);
		expect(oldCapacities.values).toBeGreaterThan(dense.valueCapacity);
		expect(oldCapacities.facts).toBeGreaterThan(dense.factCapacity);
		expect(oldCapacities.blockParameters).toBeGreaterThan(dense.blockParameterCapacity);
		expect(inspectCoreBlockHandler(dense, 1 as CoreBlockId)).toEqual({
			block: 3,
			arguments: [2],
		});
		const denseProof = dense.fact(0 as never);
		expect(denseProof).toMatchObject({
			claims: [
				{ kind: "identity", subject: 2 },
				{ kind: "effect", instruction: 0 },
			],
			validity: { kind: "guard", instruction: 1 },
			obligations: [{ kind: "guard", instruction: 1 }],
		});
		expect(dense.instructionEffectRefinement(0 as never)?.proof).toBe(0);
		expect(dense.instructionAttributes(0 as never).anchor).toBe(2);
		expect([...inspectCoreUses(dense, 2 as never)]).toEqual([
			{ instruction: 0, operand: 0 },
		]);
		expect(program.finalizeConstructionGeneration()).toBe(false);
		expect(program.function(finished.function)).toBe(dense);
		verifyCoreProgram(program);
		const sealed = program.seal();
		expect(program.seal()).toBe(sealed);
		expect(program.finalizeConstructionGeneration()).toBe(false);
	});

	it("transfers immutable attributes without local IDs across the dense barrier", () => {
		const program = new CoreProgram(registry());
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [value] = builder.appendInstruction(entry, "constant", [], {
			attributes: { literal: { kind: "number", value: 42 } },
			outputRepresentations: ["i32"],
		});
		builder.setTerminator(entry, { kind: "return", value: value! });
		const finished = builder.finish(entry);
		const attributes = program
			.function(finished.function)
			.instructionAttributes(0 as never);

		program.finalizeConstructionGeneration();

		expect(program.function(finished.function).instructionAttributes(0 as never)).toBe(
			attributes,
		);
	});

	it("produces the same dense IR regardless of construction tombstone layout", () => {
		const build = (withTombstones: boolean): string => {
			const program = new CoreProgram(registry());
			const builder = new CoreFunctionBuilder(program, { parameterCount: 1 });
			const entry = builder.createBlock([{ representation: "boxed" }]);
			const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
			const removed = withTombstones ? builder.createBlock() : undefined;
			const removedFact = withTombstones
				? builder.addFact({
						kind: "removed",
						value: null,
						claims: [],
						validity: { kind: "asserted", source: "test" },
						obligations: [],
						origin: "test",
					})
				: undefined;
			if (removed !== undefined) {
				builder.appendInstruction(removed, "constant", [], {
					attributes: { value: 999 },
					outputRepresentations: ["i32"],
				});
				builder.setTerminator(removed, { kind: "unreachable" });
			}
			const target = builder.createBlock([{ representation: "boxed" }]);
			const targetParameter = inspectCoreBlockParameters(builder, target)[0]!.value;
			builder.setTerminator(entry, {
				kind: "jump",
				edge: { block: target, arguments: [parameter] },
			});
			const [result] = builder.appendInstruction(target, "identity", [targetParameter], {
				attributes: { anchor: targetParameter },
			});
			builder.setTerminator(target, { kind: "return", value: result! });
			const functionId = builder.finish(entry).function;
			if (removed !== undefined && removedFact !== undefined) {
				const editor = CoreEditor.open(program, functionId);
				editor.removeBlock(removed);
				editor.removeFact(removedFact);
				editor.commit();
			}
			program.finalizeConstructionGeneration();
			verifyCoreProgram(program);
			return formatCoreFunction(program, functionId);
		};

		expect(build(true)).toBe(build(false));
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
		expect(inspectCoreInstructionResults(fn, 1 as never)).toEqual([copied]);
		expect(inspectCoreInstructionOperands(fn, 1 as never)).toEqual([constant]);
		expect(changes.blocks).toEqual([entry, destination]);
		expect(changes.instructions).toContain(1);
		expect(changes.domains).toEqual(["body", "cfg", "specializationInputs"]);
	});

	it("maintains exact definitions and uses when operand ranges are replaced", () => {
		const { program, fn, constant, copied, parameter } = oneFunction();
		const identity = [...fn.bodyInstructionIds(fn.entry)][1]!;
		expect(inspectCoreValueDefinition(fn, constant)).toEqual({
			kind: "instruction",
			instruction: 0,
			index: 0,
		});
		expect(inspectCoreValueDefinition(fn, parameter)).toEqual({
			kind: "block-parameter",
			block: 0,
			index: 0,
		});
		expect([...inspectCoreUses(fn, constant)]).toEqual([
			{ instruction: identity, operand: 0 },
		]);
		expect([...inspectCoreUses(fn, copied)]).toEqual([{ instruction: 2, operand: 0 }]);

		const editor = CoreEditor.open(program, fn.id);
		editor.replaceOperands(identity, [parameter]);
		editor.commit();
		expect([...inspectCoreUses(fn, constant)]).toEqual([]);
		expect([...inspectCoreUses(fn, parameter)]).toEqual([
			{ instruction: identity, operand: 0 },
		]);
		expect(fn.valueUseCount(constant)).toBe(0);
		expect(fn.valueUseCount(parameter)).toBe(1);
	});

	it("keeps scalar traversal and intrusive use storage bounded across rewrites", () => {
		const { program, fn, entry, constant, parameter } = oneFunction();
		const identity = [...fn.bodyInstructionIds(entry)][1]!;
		const operandStart = fn.kernel.instructionOperandStart(identity);
		const operandCapacity = fn.operandCapacity;
		const useCapacity = fn.useCapacity;

		for (let iteration = 0; iteration < 100; iteration++) {
			const editor = CoreEditor.open(program, fn.id);
			editor.replaceOperands(identity, [iteration % 2 === 0 ? parameter : constant]);
			editor.commit();
			verifyCoreProgram(program);
		}

		expect(fn.kernel.blockFirstInstruction(entry)).toBe(0);
		expect(fn.kernel.instructionNext(0 as never)).toBe(identity);
		expect(fn.kernel.instructionOperandStart(identity)).toBe(operandStart);
		expect(fn.kernel.instructionOperandCount(identity)).toBe(1);
		expect(fn.kernel.operandAt(operandStart)).toBe(constant);
		expect(fn.operandCapacity).toBe(operandCapacity);
		expect(fn.useCapacity).toBe(useCapacity);

		for (const value of fn.valueIds()) {
			let uses = 0;
			let previous = -1;
			for (
				let use = fn.kernel.valueFirstUse(value);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				expect(fn.kernel.useLive(use)).toBe(1);
				expect(fn.kernel.useValue(use)).toBe(value);
				expect(fn.kernel.usePrevious(use)).toBe(previous);
				previous = use;
				uses++;
			}
			expect(uses).toBe(fn.kernel.valueUseCount(value));
		}
		fn.configureUseTraversalStatistics(true);
		for (const value of fn.valueIds()) Array.from(inspectCoreUses(fn, value));
		expect(fn.useTraversalStatistics().deadSkips).toBe(0);
	});

	it("stores exception handlers in reusable scalar ranges", () => {
		const { program, fn, entry, parameter, constant, copied } = oneFunction();
		const setInitial = CoreEditor.open(program, fn.id);
		setInitial.setHandler(entry, entry, [parameter]);
		setInitial.commit();

		const start = fn.kernel.blockHandlerArgumentStart(entry);
		expect(fn.handlerBlockCount).toBe(1);
		expect(fn.handlerBlockAt(0)).toBe(entry);
		expect(fn.kernel.blockHandlerBlock(entry)).toBe(entry);
		expect(fn.kernel.blockHandlerArgumentCount(entry)).toBe(1);
		expect(fn.kernel.handlerArgumentAt(start)).toBe(parameter);
		expect(inspectCoreBlockHandler(fn, entry)).toEqual({
			block: entry,
			arguments: [parameter],
		});

		const replace = CoreEditor.open(program, fn.id);
		replace.setHandler(entry, entry, [constant]);
		replace.commit();
		expect(fn.kernel.blockHandlerArgumentStart(entry)).toBe(start);
		expect(fn.kernel.handlerArgumentAt(start)).toBe(constant);

		const clear = CoreEditor.open(program, fn.id);
		clear.clearHandler(entry);
		clear.commit();
		expect(fn.handlerBlockCount).toBe(0);
		expect(fn.kernel.blockHandlerBlock(entry)).toBeUndefined();
		expect(fn.kernel.blockHandlerArgumentCount(entry)).toBe(0);

		const reuse = CoreEditor.open(program, fn.id);
		reuse.setHandler(entry, entry, [copied]);
		reuse.commit();
		expect(fn.handlerBlockCount).toBe(1);
		expect(fn.handlerBlockAt(0)).toBe(entry);
		expect(fn.kernel.blockHandlerArgumentStart(entry)).toBe(start);
		expect(fn.kernel.handlerArgumentAt(start)).toBe(copied);
		expect(fn.kernel.valueFirstHandlerUse(copied)).toBe(start);
		expect(fn.kernel.valueHandlerUseCount(copied)).toBe(1);
		expect(fn.kernel.handlerArgumentBlock(start)).toBe(entry);
		expect(fn.kernel.handlerArgumentPreviousUse(start)).toBe(-1);
		expect(fn.kernel.handlerArgumentNextUse(start)).toBe(-1);

		const replaceUse = CoreEditor.open(program, fn.id);
		replaceUse.replaceValueUses(copied, parameter);
		replaceUse.commit();
		expect(fn.kernel.handlerArgumentAt(start)).toBe(parameter);
		expect(fn.kernel.valueFirstHandlerUse(copied)).toBe(-1);
		expect(fn.kernel.valueHandlerUseCount(copied)).toBe(0);
		expect(fn.kernel.valueFirstHandlerUse(parameter)).toBe(start);
		expect(fn.kernel.valueHandlerUseCount(parameter)).toBe(1);

		const replaceMany = CoreEditor.open(program, fn.id);
		replaceMany.replaceValueUsesMany(
			new Map([
				[parameter, constant],
				[constant, copied],
			]),
		);
		replaceMany.commit();
		expect(fn.kernel.handlerArgumentAt(start)).toBe(constant);
		expect(fn.kernel.valueFirstHandlerUse(parameter)).toBe(-1);
		expect(fn.kernel.valueHandlerUseCount(parameter)).toBe(0);
		expect(fn.kernel.valueFirstHandlerUse(constant)).toBe(start);
		expect(fn.kernel.valueHandlerUseCount(constant)).toBe(1);

		const clearReuse = CoreEditor.open(program, fn.id);
		clearReuse.clearHandler(entry);
		clearReuse.commit();
		expect(fn.kernel.valueFirstHandlerUse(constant)).toBe(-1);
		expect(fn.kernel.valueHandlerUseCount(constant)).toBe(0);
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
		editor.replaceOperands(instruction, inspectCoreInstructionOperands(fn, instruction));
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
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
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
		expect(inspectCoreInstructionLayout(fn, stable!).effectRefinementRef).toBe(0);
		expect(inspectCoreInstructionLayout(fn, replaced!).effectRefinementRef).toBe(1);
		expect(typeof inspectCoreInstructionLayout(fn, stable!).effectRefinementRef).toBe(
			"number",
		);
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
		expect(inspectCoreEffectRefinementLayout(fn, 1)).toEqual({ live: false });
		expect(inspectCoreInstructionLayout(fn, replaced!).effectRefinementRef).toBe(2);

		const clear = CoreEditor.open(program, fn.id);
		clear.clearInstructionEffectRefinement(replaced!);
		const clearChanges = clear.commit();
		expect(clearChanges.domains).toEqual([
			"memoryEffects",
			"facts",
			"specializationInputs",
		]);
		expect(clearChanges.facts).toEqual([secondFact]);
		expect(inspectCoreInstructionLayout(fn, replaced!).effectRefinementRef).toBe(-1);
		expect(inspectCoreEffectRefinementLayout(fn, 2)).toEqual({ live: false });

		const restore = CoreEditor.open(program, fn.id);
		restore.setInstructionEffectRefinement(replaced!, {
			effects: CORE_NO_EFFECTS,
			proof: firstFact,
		});
		restore.commit();
		expect(inspectCoreInstructionLayout(fn, replaced!).effectRefinementRef).toBe(3);

		const remove = CoreEditor.open(program, fn.id);
		remove.removeInstruction(replaced!);
		const removeChanges = remove.commit();
		expect(removeChanges.facts).toEqual([firstFact]);
		expect(inspectCoreInstructionLayout(fn, replaced!).effectRefinementRef).toBe(-1);
		expect(inspectCoreEffectRefinementLayout(fn, 3)).toEqual({ live: false });
		expect(fn.effectRefinementCapacity).toBe(4);

		program.seal();
		verifyCoreProgram(program);
		expect(fn.instructionEffectRefinement(stable!)).toEqual({
			effects: CORE_NO_EFFECTS,
			proof: firstFact,
		});
		expect(inspectCoreInstructionLayout(fn, stable!).effectRefinementRef).toBe(0);
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
			attributeRelocations: [],
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
		const parameter = inspectCoreBlockParameters(builder, entry)[0]!.value;
		const removed = builder.createBlock([{ representation: "i32" }]);
		const removedParameter = inspectCoreBlockParameters(builder, removed)[0]!.value;
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
		expect(fn.handlerBlockCount).toBe(1);

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
		expect(fn.handlerBlockCount).toBe(0);
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
		const operands = inspectCoreInstructionOperands(fn, identity) as Array<CoreValueId>;
		expect(() => {
			operands[0] = 99 as CoreValueId;
		}).toThrow(TypeError);
		expect(inspectCoreInstructionOperands(fn, identity)).toEqual([constant]);
	});

	it("keeps every reader result outside the mutation boundary", () => {
		const { program, fn } = oneFunction();
		const identity = [...fn.bodyInstructionIds(fn.entry)][1]!;
		const parameters = inspectCoreFunctionParameters(fn) as Array<CoreValueId>;
		expect(() => {
			parameters[0] = 99 as CoreValueId;
		}).toThrow(TypeError);
		expect(inspectCoreFunctionParameters(fn)).toEqual([0]);
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
