import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULLISH,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_TOP,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { validateNativeProgramStorage } from "../src/compiler/target/lower-native-storage.ts";
import { analyzeNativeBodyFacts } from "../src/compiler/target/native-body-facts.ts";
import {
	nativeControlFlowContract,
	selectNativeControlFlow,
} from "../src/compiler/target/native-control-flow.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type { NativeFunctionPlan } from "../src/compiler/target/program-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

let base: BytecodeFunction | undefined;
let template: NativeFunctionPlan | undefined;
function fixture(
	instructions: Array<BytecodeInstruction>,
	options: Partial<BytecodeFunction> = {},
) {
	base ??= inspectStaticValueFunction(
		"function seed(value){return value;}globalThis.seed=seed;",
		"seed",
	).fn;
	const fn: BytecodeFunction = { ...base, registerCount: 16, instructions, ...options };
	template ??= createConservativeNativePlan([base], [[], [0]]).functions[0]!;
	return {
		...template,
		body: fn,
		registerRepresentations: Array.from(
			{ length: fn.registerCount },
			() => "boxed" as const,
		),
		instructions: new Array(fn.instructions.length).fill(undefined),
		facts: undefined,
		gc: { safepoints: [] },
		storage: undefined,
	};
}
const select = (
	native: NativeFunctionPlan,
	options: Parameters<typeof selectNativeControlFlow>[3] = {},
) =>
	selectNativeControlFlow(
		native,
		analyzeNativeBodyFacts(native.body),
		[[], [0]],
		options,
	);

describe("native branch and reachability contracts", () => {
	it.each(["===", "!=="] as const)(
		"proves a self %s observation only for kinds excluding Number",
		(operator) => {
			for (let mask = 0; mask <= COMPILER_VALUE_KIND_TOP; mask++) {
				const native = {
					...fixture([
						{ opcode: "BINARY", dst: 0, left: 1, right: 1, operator },
						{ opcode: "JUMP_IF", cond: 0, targetIp: 3 },
						{ opcode: "RETURN", value: 0 },
						{ opcode: "RETURN", value: 0 },
					]),
					facts: [
						{
							inputKindMasks: [mask, mask],
							resultKindMasks: [COMPILER_VALUE_KIND_BOOLEAN],
							registers: [0, 1, 1],
							inputOffset: 1,
						},
					],
				};
				const flow = select(native);
				if (mask === 0 || (mask & COMPILER_VALUE_KIND_NUMBER) !== 0)
					expect(flow, String(mask)).toBeUndefined();
				else
					expect(flow?.branches, String(mask)).toEqual([
						{ instructionIp: 1, targetIp: operator === "===" ? 3 : 2 },
					]);
			}
		},
	);

	it.each([
		[{ opcode: "CREATE_BOOLEAN", dst: 0, value: false }, false],
		[{ opcode: "CREATE_BOOLEAN", dst: 0, value: true }, true],
		[{ opcode: "CREATE_F64", dst: 0, value: -0 }, false],
		[{ opcode: "CREATE_F64", dst: 0, value: NaN }, false],
		[{ opcode: "CREATE_F64", dst: 0, value: Infinity }, true],
		[{ opcode: "CREATE_NULL", dst: 0 }, false],
		[{ opcode: "CREATE_UNDEFINED", dst: 0 }, false],
		[{ opcode: "CREATE_STRING", dst: 0, stringIndex: 0 }, false],
		[{ opcode: "CREATE_STRING", dst: 0, stringIndex: 1 }, true],
	] satisfies Array<[BytecodeInstruction, boolean]>)(
		"decides %j by its actual truthiness",
		(producer, truthy) => {
			const native = fixture([
				producer,
				{ opcode: "JUMP_IF", cond: 0, targetIp: 3 },
				{ opcode: "RETURN", value: 0 },
				{ opcode: "RETURN", value: 0 },
			]);
			expect(select(native)).toEqual({
				branches: [{ instructionIp: 1, targetIp: truthy ? 3 : 2 }],
				unreachableIps: [truthy ? 2 : 3],
			});
		},
	);

	it("keeps joins with different writers and reads that bypass their definition", () => {
		const prefixes: Array<Array<BytecodeInstruction>> = [
			[
				{ opcode: "JUMP_IF", cond: 1, targetIp: 3 },
				{ opcode: "CREATE_BOOLEAN", dst: 0, value: false },
				{ opcode: "JUMP", targetIp: 4 },
				{ opcode: "CREATE_BOOLEAN", dst: 0, value: true },
			],
			[
				{ opcode: "JUMP_IF", cond: 1, targetIp: 4 },
				{ opcode: "CREATE_BOOLEAN", dst: 0, value: false },
				{ opcode: "JUMP", targetIp: 4 },
				{ opcode: "RETURN", value: 0 },
			],
		];
		for (const prefix of prefixes)
			expect(
				select(
					fixture([
						...prefix,
						{ opcode: "JUMP_IF", cond: 0, targetIp: 6 },
						{ opcode: "RETURN", value: 0 },
						{ opcode: "RETURN", value: 0 },
					]),
				),
			).toBeUndefined();
		expect(
			select(
				fixture([
					{ opcode: "JUMP_IF", cond: 0, targetIp: 3 },
					{ opcode: "CREATE_BOOLEAN", dst: 0, value: false },
					{ opcode: "RETURN", value: 0 },
					{ opcode: "RETURN", value: 0 },
				]),
			),
		).toBeUndefined();
	});

	it("follows long copy chains without recursion and rejects self-dependent copies", () => {
		const instructions: Array<BytecodeInstruction> = [
			{ opcode: "CREATE_BOOLEAN", dst: 0, value: false },
		];
		for (let register = 1; register < 5000; register++)
			instructions.push({ opcode: "MOVE", dst: register, src: register - 1 });
		instructions.push(
			{ opcode: "UNARY", dst: 5000, src: 4999, operator: "!" },
			{ opcode: "JUMP_IF", cond: 5000, targetIp: 5003 },
			{ opcode: "RETURN", value: 0 },
			{ opcode: "RETURN", value: 0 },
		);
		expect(select(fixture(instructions, { registerCount: 5001 }))?.branches).toEqual([
			{ instructionIp: 5001, targetIp: 5003 },
		]);
		expect(
			select(
				fixture([
					{ opcode: "MOVE", dst: 0, src: 0 },
					{ opcode: "JUMP_IF", cond: 0, targetIp: 3 },
					{ opcode: "RETURN", value: 0 },
					{ opcode: "RETURN", value: 0 },
				]),
			),
		).toBeUndefined();
	});

	it("preserves handler and resume entry labels even on an impossible ordinary edge", () => {
		const instructions: Array<BytecodeInstruction> = [
			{ opcode: "CREATE_BOOLEAN", dst: 0, value: false },
			{ opcode: "JUMP_IF", cond: 0, targetIp: 4 },
			{ opcode: "RETURN", value: 0 },
			{ opcode: "RETURN", value: 0 },
			{ opcode: "RETURN", value: 0 },
		];
		const handler = fixture(instructions, {
			handlers: [{ startIp: 0, endIp: 3, handlerIp: 4 }],
		});
		expect(select(handler)?.unreachableIps).toEqual([3]);
		const resume = fixture(
			instructions.with(3, { opcode: "AWAIT", awaitedSrc: 0, valueDst: 1, modeDst: 2 }),
			{ isAsync: true },
		);
		expect(select(resume)?.unreachableIps).toEqual([3]);
		const facts = analyzeNativeBodyFacts(handler.body);
		expect(
			selectNativeControlFlow(
				handler,
				{ ...facts, externalEntries: new Set([1, 4]) },
				[],
			),
		).toBeUndefined();
	});

	it("declines a cross-block proof when its work budget is exhausted", () => {
		const native = fixture([
			{ opcode: "CREATE_BOOLEAN", dst: 0, value: true },
			{ opcode: "JUMP", targetIp: 2 },
			{ opcode: "JUMP_IF", cond: 0, targetIp: 4 },
			{ opcode: "RETURN", value: 0 },
			{ opcode: "RETURN", value: 0 },
		]);
		expect(select(native, { workLimit: 0 })?.branches).toEqual([
			{ instructionIp: 2, targetIp: 4 },
		]);
		const outside = fixture([
			{ opcode: "CREATE_UNDEFINED", dst: 1 },
			{ opcode: "CREATE_BOOLEAN", dst: 0, value: true },
			{ opcode: "JUMP", targetIp: 3 },
			{ opcode: "JUMP_IF", cond: 0, targetIp: 5 },
			{ opcode: "RETURN", value: 0 },
			{ opcode: "RETURN", value: 0 },
		]);
		expect(select(outside, { workLimit: 0 })).toBeUndefined();
		expect(select(outside, { workLimit: 100 })?.branches).toEqual([
			{ instructionIp: 3, targetIp: 5 },
		]);
	});

	it("removes polls only from untaken edges and retains surviving root maps intact", () => {
		for (const value of [false, true]) {
			const point = {
				instructionIp: 1,
				kind: "loop-backedge" as const,
				rootRegisters: [0],
				incomingRootRegisters: [0],
				outgoingRootRegisters: [0],
			};
			const native = {
				...fixture([
					{ opcode: "CREATE_BOOLEAN", dst: 0, value },
					{ opcode: "JUMP_IF", cond: 0, targetIp: 0 },
					{ opcode: "RETURN", value: 0 },
				]),
				gc: { safepoints: [point] },
			};
			const contract = nativeControlFlowContract(native, select(native));
			expect(contract.gc.safepoints).toEqual(value ? [point] : []);
			if (value) expect(contract.gc.safepoints[0]).toBe(point);
			expect(native.gc.safepoints).toEqual([point]);
			const adjacent = {
				...native,
				body: {
					...native.body,
					instructions: native.body.instructions.with(1, {
						opcode: "JUMP_IF",
						cond: 0,
						targetIp: 2,
					}),
				},
			};
			expect(select(adjacent)).toBeUndefined();
			expect(nativeControlFlowContract(adjacent, select(adjacent)).gc.safepoints).toEqual(
				[point],
			);
		}
	});

	it("consumes input facts at the branch without assuming a prior definition", () => {
		const base = fixture([
			{ opcode: "JUMP_IF", cond: 0, targetIp: 2 },
			{ opcode: "RETURN", value: 0 },
			{ opcode: "RETURN", value: 0 },
		]);
		const native = {
			...base,
			facts: [
				{
					inputKindMasks: [COMPILER_VALUE_KIND_NULLISH],
					registers: [0],
					inputOffset: 0,
				},
				undefined,
				undefined,
			],
		};
		expect(select(native)).toEqual({
			branches: [{ instructionIp: 0, targetIp: 1 }],
			unreachableIps: [2],
		});
		expect(select(native, { externalEntries: [0] })).toBeUndefined();
	});

	it.each([false, true])(
		"persists and revalidates distinct canonical/typed facts with profiling %s",
		(profile) => {
			const out = inspectStaticValueFunction(
				"function probe(left,value){if(Number.isFinite(value))return left+1;return 0;}globalThis.probe=probe;globalThis.result=probe(globalThis.input,String(globalThis.text));",
				"probe",
				{ profile },
			);
			expect(out.native.storage?.controlFlow).toBeUndefined();
			const entry = out.native.directEntries[0]!;
			const flow = entry.storage?.controlFlow;
			expect(flow?.branches.length).toBeGreaterThan(0);
			expect(
				flow?.unreachableIps.some(
					(ip) => out.native.body.instructions[ip]?.opcode === "BINARY",
				),
			).toBe(true);
			expect(out.native.storage!.rootSlotCount).toBeGreaterThan(0);
			expect(entry.storage!.rootSlotCount).toBe(0);
			expect(out.c.source).toContain("MAL_BIN_ADD");
			const typedC = out.c.directEntries[0]!.source;
			expect(typedC).not.toContain("MAL_BIN_ADD");
			expect(typedC).not.toContain("MalRootFrame");
			expect(typedC).not.toMatch(/if \(r\d+\) goto/);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
			expect(
				restored.native.functions[out.native.functionIndex]!.directEntries[0]!.storage
					?.controlFlow,
			).toEqual(flow);
			const bad = {
				...entry,
				storage: { ...entry.storage!, controlFlow: { branches: [], unreachableIps: [] } },
			};
			const functions = restored.native.functions.with(out.native.functionIndex, {
				...out.native,
				directEntries: [bad],
			});
			expect(() =>
				validateNativeProgramStorage(
					{ ...restored.native, functions },
					restored.runtime.stringConstants,
				),
			).toThrow(/storage plan/);
		},
	);

	it("removes the dead addition from both Number.isNaN String entry variants", () => {
		const out = inspectStaticValueFunction(
			"function probe(left,value){if(Number.isNaN(value))return left+1;return 0;}globalThis.probe=probe;globalThis.result=probe(globalThis.input,String(globalThis.text));",
			"probe",
		);
		const typed = out.c.directEntries[0]!.source;
		expect(typed).toContain("__full:");
		expect(typed).not.toContain("mal_value_is_truthy(");
		expect(typed).not.toContain("mal_ops_is_number(");
		expect(out.c.source).toContain("MAL_BIN_ADD");
	});
});
