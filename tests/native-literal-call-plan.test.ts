import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	lowerNativeStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import { mergeProgramImages } from "../src/test262/program-image-merge.ts";

function mathImage() {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`globalThis.calculate = function calculate(a, b) { return Math.round(a) + Math.max(a, b); };`,
			"/literal-call-plan.js",
		),
	);
}

function propertyImage(key: string) {
	const original = mathImage();
	const instructions = [
		{ opcode: "CREATE_OBJECT" as const, dst: 0 },
		{ opcode: "CREATE_UNDEFINED" as const, dst: 2 },
		{ opcode: "CREATE_STRING" as const, dst: 1, stringIndex: 0 },
		{
			opcode: "DEFINE_PROPERTY" as const,
			object: 0,
			key: 1,
			value: 2,
			enumerable: true,
			writable: true,
			configurable: true,
		},
		{ opcode: "RETURN" as const, value: 0 },
	];
	const body = {
		...original.runtime.functions[0]!,
		registerCount: 3,
		capturedCount: 0,
		parameterCount: 0,
		propertyIcCount: 0,
		literalShapeCount: 0,
		handlers: [],
		instructions,
		positions: instructions.map(() => 0),
	};
	const runtime = {
		...original.runtime,
		functions: [body],
		functionCount: 1,
		stringConstants: [[...key].map((unit) => unit.charCodeAt(0))],
		globalCount: 0,
		precompiledLiteralShapes: [],
	};
	return {
		runtime,
		native: createConservativeNativePlan([body], runtime.stringConstants),
		diagnostics: {},
	};
}

describe("persisted literal and Math call choices", () => {
	it.each(["field", "", "01", "4294967295"])(
		"round-trips and rebases non-index key %s",
		(key) => {
			const image = propertyImage(key);
			const plan = image.native.functions[0]!.storage!.literalPropertyDefinitions[0]!;
			expect(plan).toBeDefined();
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(
				image,
			);
			const merged = mergeProgramImages([image, image]);
			expect(
				merged.image.native.functions[1]!.storage!.literalPropertyDefinitions[0]!
					.stringIndex,
			).toBe(1);
			expect(() => serializeCompilerArtifact(merged.image)).not.toThrow();
			for (const stringConstants of [
				[],
				[[48]],
				[[52, 50, 57, 52, 57, 54, 55, 50, 57, 52]],
			])
				expect(() =>
					validateNativeStorage(image.native.functions[0]!, undefined, stringConstants),
				).toThrow(/invalid or stale storage plan/);
		},
	);

	it.each(["0", "1", "4294967294"])(
		"retains the generic definition for index key %s",
		(key) => {
			expect(
				propertyImage(key).native.functions[0]!.storage!.literalPropertyDefinitions,
			).toEqual([]);
		},
	);

	it("declines literal-key specialization when control enters after the producer", () => {
		const image = propertyImage("field");
		const native = image.native.functions[0]!;
		const body = {
			...native.body,
			instructions: [
				...native.body.instructions,
				{ opcode: "JUMP" as const, targetIp: 3 },
			],
		};
		const changed = lowerNativeStorage({
			...image,
			native: { ...image.native, functions: [{ ...native, body }] },
		});
		expect(changed.native.functions[0]!.storage!.literalPropertyDefinitions).toEqual([]);
	});

	it("persists guarded unary and binary modes and rejects a forged numeric mode", () => {
		const image = mathImage();
		const native = image.native.functions[1]!;
		expect(
			native.storage!.mathCalls.map(({ operation, arity, mode }) => ({
				operation,
				arity,
				mode,
			})),
		).toEqual([
			{ operation: "Math.round", arity: 1, mode: "guarded-boxed" },
			{ operation: "Math.max", arity: 2, mode: "guarded-boxed" },
		]);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(image))).toEqual(image);
		expect(() =>
			validateNativeStorage(
				{
					...native,
					storage: {
						...native.storage!,
						mathCalls: native.storage!.mathCalls.map((plan) => ({
							...plan,
							mode: "number",
						})),
					},
				},
				undefined,
				image.runtime.stringConstants,
			),
		).toThrow(/invalid or stale storage plan/);
	});
});
