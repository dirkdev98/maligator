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
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

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
	it.each([
		"console.log(value)",
		"globalThis.console.log(value)",
		"(()=>{const target=console;return target.log(value)})()",
		"JSON.log(value)",
	])("declines unrelated namespace guesses for %s", (expression) => {
		for (const locked of [false, true]) {
			const out = inspectStaticValueFunction(
				`function probe(value){return ${expression};}globalThis.probe=probe;`,
				"probe",
				{ locked },
			);
			expect(out.native.storage!.mathCalls).toEqual([]);
			expect(out.native.body.instructions.some((op) => op.opcode === "CALL")).toBe(true);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		}
	});

	it.each(["Math.log(value)", "target.log(value)"])(
		"keeps a loaded-callee guard when %s remains a useful candidate",
		(expression) => {
			const out = inspectStaticValueFunction(
				`function probe(value,target){return ${expression};}globalThis.probe=probe;`,
				"probe",
				{ locked: false },
			);
			expect(out.native.storage!.mathCalls.map((plan) => plan.operation)).toEqual([
				"Math.log",
			]);
		},
	);

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
	it.each([0, 1])(
		"requires literal identity across a key join with alternative %i",
		(alternative) => {
			const image = propertyImage("field");
			const original = image.native.functions[0]!.body;
			const instructions = [
				{ opcode: "CREATE_OBJECT", dst: 1 },
				{ opcode: "JUMP_IF", cond: 0, targetIp: 4 },
				{ opcode: "CREATE_STRING", dst: 2, stringIndex: 0 },
				{ opcode: "JUMP", targetIp: 6 },
				{ opcode: "CREATE_STRING", dst: 2, stringIndex: alternative },
				{ opcode: "JUMP", targetIp: 6 },
				{ opcode: "TO_PROPERTY_KEY", dst: 3, object: 1, key: 2 },
				{
					opcode: "DEFINE_PROPERTY",
					object: 1,
					key: 3,
					value: 0,
					enumerable: true,
					writable: true,
					configurable: true,
				},
				{ opcode: "RETURN", value: 1 },
			] satisfies typeof original.instructions;
			const body = {
				...original,
				parameterCount: 1,
				registerCount: 4,
				instructions,
				positions: instructions.map(() => 0),
			};
			const strings = ["field", "other"].map((value) =>
				[...value].map((c) => c.charCodeAt(0)),
			);
			const native = createConservativeNativePlan([body], strings).functions[0]!;
			expect(native.storage!.literalPropertyDefinitions).toEqual(
				alternative === 0 ? [{ instructionIp: 7, stringIndex: 0 }] : [],
			);
		},
	);

	it("persists guarded unary and binary calls and rejects a mismatched arity", () => {
		const image = mathImage();
		const native = image.native.functions[1]!;
		expect(
			native.storage!.mathCalls.map(({ operation, arity }) => ({
				operation,
				arity,
			})),
		).toEqual([
			{ operation: "Math.round", arity: 1 },
			{ operation: "Math.max", arity: 2 },
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
							arity: plan.arity === 1 ? 2 : 1,
						})),
					},
				},
				undefined,
				image.runtime.stringConstants,
			),
		).toThrow(/invalid or stale storage plan/);
	});
});
