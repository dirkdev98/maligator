import { expect, test } from "vitest";
import { knownFact } from "../src/compiler-facts.ts";
import type { KnownBuiltinCall } from "../src/compiler-facts.ts";
import type { IntermediateProgram, IRFunction, IRInstruction } from "../src/ir.ts";
import {
	allocateDevelopmentRegisters,
	allocateRegisters,
	inferVirtualReps,
} from "../src/register-alloc.ts";

function allocate(
	blocks: Array<Array<IRInstruction>>,
	options: { parameterCount?: number; registerCount?: number } = {},
): IRFunction {
	const fn = {
		parameterCount: options.parameterCount ?? 0,
		nextRegisterDestination: options.registerCount ?? 0,
		blocks: blocks.map((instructions) => ({ instructions })),
	} as unknown as IRFunction;
	allocateRegisters({ functions: [fn] } as unknown as IntermediateProgram);
	return fn;
}

test("colors mutually exclusive diamond definitions together", () => {
	const leftValue: IRInstruction = { type: "createObject", registers: [1] };
	const leftMerge: IRInstruction = { type: "move", registers: [3, 1] };
	const rightValue: IRInstruction = { type: "createObject", registers: [2] };
	const rightMerge: IRInstruction = { type: "move", registers: [3, 2] };
	const fn = allocate(
		[
			[
				{ type: "createBoolean", registers: [0], value: true },
				{ type: "jumpIf", registers: [0], blocks: [2] },
			],
			[leftValue, leftMerge, { type: "jump", blocks: [3] }],
			[rightValue, rightMerge, { type: "jump", blocks: [3] }],
			[{ type: "return", registers: [3] }],
		],
		{ registerCount: 4 },
	);

	expect(leftValue.registers[0]).toBe(rightValue.registers[0]);
	expect(leftMerge.registers[0]).not.toBe(leftValue.registers[0]);
	expect(rightMerge.registers[0]).not.toBe(rightValue.registers[0]);
	expect(fn.nextRegisterDestination).toBeLessThan(4);
});

test("keeps handler live-ins away from throwing-instruction destinations", () => {
	const handlerValue: IRInstruction = { type: "createObject", registers: [1] };
	const call: IRInstruction = { type: "call", registers: [4, 2, 3] };
	allocate(
		[
			[
				handlerValue,
				{ type: "createFunction", registers: [2], functionIndex: 0 },
				{ type: "createUndefined", registers: [3] },
				{ type: "tryBegin", blocks: [1, 2] },
				call,
				{ type: "tryEnd" },
				{ type: "return", registers: [3] },
			],
			[
				{ type: "catch", registers: [5] },
				{ type: "binary", registers: [6, 5, 1], operator: "+" },
				{ type: "return", registers: [6] },
			],
			[{ type: "return", registers: [3] }],
		],
		{ registerCount: 7 },
	);

	expect(call.registers[0]).not.toBe(handlerValue.registers[0]);
});

test("keeps dual destinations and distinct sources separate in a loop", () => {
	const iteratorStep: IRInstruction = {
		type: "iteratorStep",
		registers: [2, 3, 0, 1],
	};
	allocate(
		[
			[
				{ type: "createObject", registers: [0] },
				{ type: "createFunction", registers: [1], functionIndex: 0 },
				{ type: "jump", blocks: [1] },
			],
			[
				iteratorStep,
				{ type: "jumpIf", registers: [3], blocks: [2] },
				{ type: "jump", blocks: [1] },
			],
			[{ type: "return", registers: [2] }],
		],
		{ registerCount: 4 },
	);

	expect(new Set(iteratorStep.registers)).toHaveLength(4);
});

test("reserves parameter colors and preserves dense argument snapshots", () => {
	const countSnapshot: IRInstruction = { type: "loadArgumentCount", registers: [5] };
	const valueSnapshot: IRInstruction = { type: "loadArgument", registers: [6], index: 0 };
	const temporary: IRInstruction = { type: "createObject", registers: [7] };
	allocate(
		[
			[
				countSnapshot,
				valueSnapshot,
				{ type: "createBoolean", registers: [8], value: true },
				{ type: "jump", blocks: [1] },
			],
			[
				temporary,
				{ type: "jumpIf", registers: [8], blocks: [2] },
				{ type: "jump", blocks: [1] },
			],
			[{ type: "return", registers: [5] }],
		],
		{ parameterCount: 2, registerCount: 9 },
	);

	expect(countSnapshot.registers[0]).toBe(2);
	expect(valueSnapshot.registers[0]).toBe(3);
	expect(temporary.registers[0]).toBeGreaterThanOrEqual(2);
});

test("development allocation keeps every virtual value distinct", () => {
	const countSnapshot: IRInstruction = { type: "loadArgumentCount", registers: [5] };
	const valueSnapshot: IRInstruction = { type: "loadArgument", registers: [6], index: 0 };
	const loopValue: IRInstruction = { type: "createObject", registers: [7] };
	const loopResult: IRInstruction = { type: "move", registers: [8, 7] };
	const fn = {
		parameterCount: 2,
		nextRegisterDestination: 9,
		blocks: [
			{
				instructions: [countSnapshot, valueSnapshot, { type: "jump", blocks: [1] }],
			},
			{
				instructions: [loopValue, loopResult, { type: "jump", blocks: [1] }],
			},
		],
	} as unknown as IRFunction;

	allocateDevelopmentRegisters({ functions: [fn] } as unknown as IntermediateProgram);

	expect(countSnapshot.registers[0]).toBe(2);
	expect(valueSnapshot.registers[0]).toBe(3);
	expect(loopValue.registers[0]).not.toBe(loopResult.registers[0]);
	expect(fn.nextRegisterDestination).toBe(6);
});

test("development allocation retains an already valid virtual register namespace", () => {
	const snapshot: IRInstruction = { type: "loadArgumentCount", registers: [1] };
	const value: IRInstruction = { type: "createObject", registers: [8] };
	const fn = {
		parameterCount: 1,
		nextRegisterDestination: 9,
		blocks: [{ instructions: [snapshot, value] }],
	} as unknown as IRFunction;

	allocateDevelopmentRegisters({ functions: [fn] } as unknown as IntermediateProgram);

	expect(snapshot.registers[0]).toBe(1);
	expect(value.registers[0]).toBe(8);
	expect(fn.nextRegisterDestination).toBe(9);
});

test("never shares a physical register across representation classes", () => {
	const number: IRInstruction = { type: "createNumber", registers: [0], value: 1 };
	const boolean: IRInstruction = { type: "createBoolean", registers: [1], value: true };
	const boxed: IRInstruction = { type: "createObject", registers: [2] };
	allocate(
		[
			[number, boolean, boxed, { type: "jump", blocks: [1] }],
			[
				{ type: "createNumber", registers: [3], value: 2 },
				{ type: "jumpIf", registers: [1], blocks: [2] },
				{ type: "jump", blocks: [1] },
			],
			[{ type: "return", registers: [2] }],
		],
		{ registerCount: 4 },
	);

	expect(
		new Set([number.registers[0], boolean.registers[0], boxed.registers[0]]),
	).toHaveLength(3);
});

test("partitions guarded numeric parameter values from later boxed reuse", () => {
	const store = {
		type: "storeProperty",
		registers: [2, 3, 1],
	} as IRInstruction;
	const parameterCopy: IRInstruction = { type: "move", registers: [1, 0] };
	const finiteAllocation = {
		type: "createObject",
		registers: [2, 1],
		nativeFiniteConstruction: {
			source: store,
			keyStringIndices: [0],
		},
	} as IRInstruction;
	const laterBoxed: IRInstruction = { type: "createObject", registers: [4] };
	allocate(
		[[parameterCopy, finiteAllocation, laterBoxed, { type: "return", registers: [4] }]],
		{
			parameterCount: 1,
			registerCount: 5,
		},
	);

	expect(parameterCopy.registers[0]).not.toBe(laterBoxed.registers[0]);
});

test("keeps an appended-block numeric loop induction unboxed", () => {
	// Multi-block inlining appends the callee entry after the caller's original
	// blocks, then jumps back to the caller continuation. The representation
	// fixpoint must preserve unknown forward definitions as lattice top: treating
	// the first self-update as boxed permanently poisons this numeric induction.
	const fn = {
		parameterCount: 0,
		nextRegisterDestination: 4,
		blocks: [
			[{ type: "jump", blocks: [2] }],
			[
				{ type: "createNumber", registers: [1], value: 10 },
				{ type: "binary", registers: [2, 0, 1], operator: "<" },
				{ type: "jumpIf", registers: [2], blocks: [3] },
				{ type: "return", registers: [0] },
			],
			[
				{ type: "createNumber", registers: [0], value: 0 },
				{ type: "jump", blocks: [1] },
			],
			[
				{ type: "unary", registers: [0, 0], operator: "increment" },
				{ type: "jump", blocks: [1] },
			],
		].map((instructions) => ({ instructions })) as Array<{
			instructions: Array<IRInstruction>;
		}>,
	} as unknown as IRFunction;

	expect(inferVirtualReps(fn).get(0)).toBe("number");
});

test("keeps locked native-number builtin results unboxed before allocation", () => {
	const proof = {
		scope: { kind: "world" as const },
		dependencies: [{ kind: "world" as const, fact: "primordials.locked" as const }],
		obligations: [{ kind: "fallback" as const, id: "generic-call:test" }],
		origin: "test",
	};
	const knownBuiltinCall: KnownBuiltinCall = {
		operation: "Math.floor",
		identity: knownFact("Math.floor", proof),
		semantics: knownFact(
			{
				effects: ["coerce", "throw"],
				result: "number",
				lowerings: ["generic", "native-number"],
			},
			proof,
		),
	};
	const fn = {
		parameterCount: 0,
		nextRegisterDestination: 4,
		blocks: [
			{
				instructions: [
					{ type: "createNumber", registers: [0], value: 1.25 },
					{ type: "createObject", registers: [1] },
					{ type: "createObject", registers: [2] },
					{
						type: "call",
						registers: [3, 1, 2, 0],
						knownBuiltinCall,
					},
					{ type: "return", registers: [3] },
				] as Array<IRInstruction>,
			},
		],
	} as unknown as IRFunction;

	expect(inferVirtualReps(fn).get(3)).toBe("number");
});
