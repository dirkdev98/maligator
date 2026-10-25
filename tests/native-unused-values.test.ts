import { describe, expect, it } from "vitest";
import { NO_EFFECT_SUMMARY } from "../src/compiler/shared/effect-summary.ts";
import { EFFECT_DOMAINS } from "../src/compiler/shared/effect-summary.ts";
import {
	encodeInstructionEffects,
	INSTRUCTION_CALLS_USER_CODE,
	INSTRUCTION_MAY_GC,
	INSTRUCTION_MAY_SUSPEND,
	INSTRUCTION_MAY_THROW,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { validateNativeProgramStorage } from "../src/compiler/target/lower-native-storage.ts";
import { lowerNativeFunctionStorage } from "../src/compiler/target/lower-native-storage.ts";
import { analyzeNativeBodyFacts } from "../src/compiler/target/native-body-facts.ts";
import { selectNativeUnusedValues } from "../src/compiler/target/native-unused-values.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type { NativeFunctionPlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

let base: BytecodeFunction | undefined;
function fixture(instructions: Array<BytecodeInstruction>) {
	base ??= inspectStaticValueFunction(
		"function seed(){return 1;}globalThis.seed=seed;",
		"seed",
	).fn;
	const fn = { ...base, registerCount: 8, instructions };
	return { ...createConservativeNativePlan([fn]).functions[0]!, gc: { safepoints: [] } };
}

const select = (
	native: NativeFunctionPlan,
	options: Partial<Parameters<typeof selectNativeUnusedValues>[2]> = {},
) =>
	selectNativeUnusedValues(native, analyzeNativeBodyFacts(native.body), {
		controlFlow: undefined,
		blocked: new Set(),
		borrowed: new Set(),
		roots: [],
		numberPredicates: new Set(),
		...options,
	});

describe("native unused-value contracts", () => {
	it("retains a jump label at an elided producer and omits its local declaration", () => {
		const native = lowerNativeFunctionStorage(
			fixture([
				{ opcode: "JUMP", targetIp: 1 },
				{ opcode: "CREATE_NUMBER", dst: 0, value: 7 },
				{ opcode: "RETURN", value: -1 },
			]),
		);
		expect(native.storage!.elidedPureIps).toEqual([1]);
		const emitted = emitCompiledFunction(native, 0, "", false)!;
		expect(emitted.source).toContain("L1:;");
		expect(emitted.source).not.toMatch(/\br0\b/);
	});

	it("removes only a selected inline predicate and preserves extra argument effects", () => {
		const native = fixture([
			{ opcode: "CREATE_NUMBER", dst: 0, value: 7 },
			{
				opcode: "CALL",
				dst: 1,
				callee: 0,
				thisValue: -1,
				argumentCount: 0,
				arguments: [],
			},
			{
				opcode: "CALL_KNOWN",
				dst: 2,
				operation: "Number.isFinite",
				thisValue: -1,
				argumentCount: 2,
				arguments: [0, 1],
			},
			{ opcode: "RETURN", value: -1 },
		]);
		expect(select(native)).toEqual([]);
		expect(select(native, { numberPredicates: new Set([2]) })).toEqual([2]);
	});

	it("removes dead copy cycles while retaining every writer of an observed register", () => {
		const native = fixture([
			{ opcode: "CREATE_NUMBER", dst: 0, value: 7 },
			{ opcode: "MOVE", dst: 1, src: 2 },
			{ opcode: "MOVE", dst: 2, src: 1 },
			{ opcode: "JUMP_IF", cond: 0, targetIp: 5 },
			{ opcode: "CREATE_NUMBER", dst: 3, value: 8 },
			{ opcode: "CREATE_NUMBER", dst: 3, value: 9 },
			{ opcode: "RETURN", value: 3 },
		]);
		expect(select(native)).toEqual([1, 2]);
		expect(
			select(native, {
				controlFlow: {
					branches: [{ instructionIp: 3, targetIp: 5 }],
					unreachableIps: [4],
				},
			}),
		).toEqual([0, 1, 2]);
	});

	it("retains prologue inputs, explicit root writes and hidden borrowed uses", () => {
		const native = fixture([
			{ opcode: "CREATE_NUMBER", dst: 0, value: 7 },
			{ opcode: "MOVE", dst: 1, src: 0 },
			{ opcode: "MOVE", dst: 2, src: 1 },
			{ opcode: "RETURN", value: -1 },
		]);
		expect(select(native)).toEqual([0, 1, 2]);
		for (const options of [
			{ roots: [2] },
			{ borrowed: new Set([2]) },
			{ blocked: new Set([2]) },
		])
			expect(select(native, options)).toEqual([]);
		expect(select({ ...native, body: { ...native.body, parameterCount: 3 } })).toEqual(
			[],
		);
		expect(
			select({ ...native, body: { ...native.body, argumentSnapshotCount: 3 } }),
		).toEqual([]);
	});

	it.each([
		undefined,
		INSTRUCTION_MAY_THROW,
		INSTRUCTION_MAY_SUSPEND,
		INSTRUCTION_MAY_GC,
		INSTRUCTION_CALLS_USER_CODE,
		...EFFECT_DOMAINS.map((domain) =>
			encodeInstructionEffects({ ...NO_EFFECT_SUMMARY, writes: [domain] }),
		),
	])("retains unused operators with effect mask %s", (effectMask) => {
		const native = {
			...fixture([
				{ opcode: "CREATE_NUMBER", dst: 0, value: 7 },
				{ opcode: "UNARY", dst: 1, src: 0, operator: "+" },
				{ opcode: "RETURN", value: -1 },
			]),
			facts: [undefined, effectMask === undefined ? undefined : { effectMask }],
		};
		expect(select(native)).toEqual([]);
		expect(select({ ...native, facts: [undefined, { effectMask: 0 }] })).toEqual([0, 1]);
	});

	it("keeps allocation and call runtime obligations even with empty semantic effects", () => {
		const native = {
			...fixture([
				{ opcode: "CREATE_NUMBER", dst: 0, value: 7 },
				{ opcode: "CREATE_ARRAY", dst: 1, length: 1 },
				{
					opcode: "CALL",
					dst: 2,
					callee: 0,
					thisValue: -1,
					arguments: [],
					argumentCount: 0,
				},
				{ opcode: "RETURN", value: -1 },
			]),
			facts: [{ effectMask: 0 }, { effectMask: 0 }, { effectMask: 0 }],
		};
		expect(select(native)).toEqual([]);
	});

	it.each([{ sites: [] }, { sites: [-1, -1] }])(
		"preserves every producer with profile map $sites",
		({ sites }) => {
			const native = fixture([
				{ opcode: "CREATE_NUMBER", dst: 0, value: 7 },
				{ opcode: "RETURN", value: -1 },
			]);
			expect(
				select({ ...native, body: { ...native.body, profileSiteIds: sites } }),
			).toEqual([]);
		},
	);

	it.each([false, true])(
		"elides the typed String NaN predicate with profile=%s and preserves the canonical check",
		(profile) => {
			const out = inspectStaticValueFunction(
				"function probe(left,value){if(Number.isNaN(value))return left+1;return 0;}globalThis.probe=probe;globalThis.result=probe(globalThis.input,String(globalThis.text));",
				"probe",
				{ profile },
			);
			const compareIp = out.fn.instructions.findIndex(
				(op) => op.opcode === "BINARY" && op.operator === "!==" && op.left === op.right,
			);
			expect(compareIp).toBeGreaterThanOrEqual(0);
			expect(out.native.storage!.elidedPureIps).not.toContain(compareIp);
			const entry = out.native.directEntries[0]!;
			expect(entry.storage!.elidedPureIps.includes(compareIp)).toBe(!profile);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(out.image));
			expect(restored.native.functions[out.native.functionIndex]!.storage).toEqual(
				out.native.storage,
			);
			expect(
				restored.native.functions[out.native.functionIndex]!.directEntries[0]!.storage,
			).toEqual(entry.storage);
			expect(
				emitCompiledFunction(
					restored.native.functions[out.native.functionIndex]!,
					out.native.functionIndex,
					"",
					false,
					"static",
					new Set(),
					[],
					new Map(),
					false,
					new Set(),
					restored.runtime.stringConstants,
				),
			).toEqual(out.c);
			const functions = restored.native.functions.with(out.native.functionIndex, {
				...out.native,
				storage: { ...out.native.storage!, elidedPureIps: [compareIp] },
			});
			expect(() =>
				validateNativeProgramStorage(
					{ ...restored.native, functions },
					restored.runtime.stringConstants,
				),
			).toThrow(/storage plan/);
		},
	);
});
