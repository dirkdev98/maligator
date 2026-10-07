import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeFunctionStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";

function compile() {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.kernel = function kernel(first, second, consume) {
				const left = first();
				consume(left);
				const right = second();
				return consume(right);
			};`,
			"/root-storage.js",
		),
	);
}

function contract(rootedOutput = false) {
	const template = compile().native.functions[1]!.body;
	const call = (dst: number, arguments_: Array<number> = []): BytecodeInstruction => ({
		opcode: "CALL",
		dst,
		callee: 0,
		thisValue: -1,
		argumentCount: arguments_.length,
		arguments: arguments_,
	});
	const instructions: Array<BytecodeInstruction> = [
		rootedOutput
			? {
					opcode: "CALL_KNOWN",
					dst: 2,
					operation: "Array.from",
					thisValue: -1,
					argumentCount: 1,
					arguments: [1],
				}
			: call(2),
		call(3, [2]),
		call(4),
		call(5, [4]),
		{ opcode: "RETURN", value: 5 },
	];
	const body = {
		...template,
		parameterCount: 2,
		registerCount: 6,
		instructions,
		positions: instructions.map(() => -1),
	};
	const native = createConservativeNativePlan([body]).functions[0]!;
	const live = [
		[
			[0, 1],
			[0, 1, 2],
		],
		[
			[0, 1, 2],
			[0, 1, 3],
		],
		[
			[0, 1],
			[0, 1, 4],
		],
		[
			[0, 1, 4],
			[0, 1, 5],
		],
	];
	return lowerNativeFunctionStorage({
		...native,
		storageValues: Array.from({ length: 6 }, (_, index) => index),
		gc: {
			safepoints: live.map(([incoming, outgoing], instructionIp) => ({
				kind: "operation",
				instructionIp,
				rootRegisters: [...new Set([...incoming!, ...outgoing!])].sort((a, b) => a - b),
				incomingRootRegisters: incoming!,
				outgoingRootRegisters: outgoing!,
			})),
		},
	});
}

describe("native physical root storage", () => {
	it("shares disjoint SSA roots while preserving helper input/output interference", () => {
		const fn = contract();
		const storage = fn.storage!;
		const slots = new Map(
			storage.rootRegisters.map((register, index) => [
				register,
				storage.rootSlots[index],
			]),
		);
		expect(storage.rootSlotCount).toBeLessThan(storage.rootRegisters.length);
		expect(slots.get(2)).toBe(slots.get(4));
		expect(slots.get(3)).toBe(slots.get(5));
		for (const point of fn.gc.safepoints)
			expect(
				new Set(point.rootRegisters.map((register) => slots.get(register))).size,
			).toBe(point.rootRegisters.length);
		for (const parameter of [0, 1])
			expect(
				storage.rootSlots.filter((slot) => slot === slots.get(parameter)),
			).toHaveLength(1);
	});

	it("keeps helper output addresses dedicated even when later roots are disjoint", () => {
		const storage = contract(true).storage!;
		const slot = storage.rootSlots[storage.rootRegisters.indexOf(2)]!;
		expect(storage.rootSlots.filter((candidate) => candidate === slot)).toHaveLength(1);
	});

	it("renders a shared slot's live occupant without clearing it for its dead aliases", () => {
		const fn = contract();
		const source = emitCompiledFunction(fn, 0, "", false)!.source;
		const slot = fn.storage!.rootSlots[fn.storage!.rootRegisters.indexOf(2)];
		const call = source.indexOf("MalCompletion call_result_1 =");
		const precedingCall = source.indexOf("r2 = call_result_0.value;");
		const publication = source.slice(precedingCall, call);
		expect(publication).toContain(`__gc_slots[${slot}] = r2;`);
		expect(publication).not.toContain(`__gc_slots[${slot}] = MAL_VALUE_UNDEFINED;`);
		expect(source).toContain(`MalValue __gc_slots[${fn.storage!.rootSlotCount}];`);
	});

	it("round-trips the selected layout and rejects forged slot aliases and frame sizes", () => {
		const image = compile();
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[1]!.storage).toEqual(
			image.native.functions[1]!.storage,
		);
		const actual = restored.native.functions[1]!;
		expect(actual.storage!.rootSlotCount).toBeLessThan(
			actual.storage!.rootRegisters.length,
		);
		expect(emitCompiledFunction(actual, actual.functionIndex, "", false)).not.toBeNull();
		const fn = contract();
		for (const storage of [
			{ ...fn.storage!, rootSlots: fn.storage!.rootSlots.map(() => 0) },
			{ ...fn.storage!, rootSlotCount: fn.storage!.rootSlotCount - 1 },
		])
			expect(() => validateNativeStorage({ ...fn, storage })).toThrow(
				/invalid or stale storage plan/,
			);
	});
});
