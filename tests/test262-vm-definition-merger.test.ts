import { describe, expect, it } from "vitest";
import type {
	ProgramImage,
	BytecodeFunction,
	BytecodeInstruction,
	NativePlan,
	RuntimeImage,
} from "../src/compiler/target/lower-vm.ts";
import { mergeProgramImages } from "../src/test262/vm-definition-merge.ts";
import { testProgramImage, withNativeFunctionPlan } from "./helpers/program-image.ts";

function vmFunction(instructions: Array<BytecodeInstruction>): BytecodeFunction {
	return {
		nameStringIndex: 0,
		isGenerator: false,
		isAsync: false,
		parameterCount: 0,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 0,
		registerCount: 8,
		capturedCount: 0,
		strict: true,
		needsArguments: false,
		argumentSnapshotCount: 0,
		argumentSnapshotPlan: [],
		isDerivedConstructor: false,
		isClassConstructor: false,
		hasPrototype: false,
		literalShapeCount: instructions.filter(
			(instruction) => instruction.opcode === "CREATE_OBJECT_SHAPED",
		).length,
		instructions,
		handlers: [{ startIp: 0, endIp: 1, handlerIp: 1 }],
		fileIndex: 0,
		positions: instructions.map(() => 0),
	};
}

function definition(
	overrides: Partial<RuntimeImage> = {},
	nativeOverrides: Partial<NativePlan> = {},
): ProgramImage {
	const functions = overrides.functions ?? [vmFunction([{ opcode: "RETURN", value: 0 }])];
	const image = testProgramImage({
		entrypointPath: "input.js",
		functionCount: functions.length,
		functions,
		stringConstants: [[65]],
		bigintConstants: [1n],
		literalTemplateData: [8, 0],
		precompiledLiteralShapes: [],
		globalCount: 1,
		files: ["input.js"],
		sourcePositions: [{ line: 1, column: 0 }],
		cjsModuleFunctionIndices: [],
		hostInstalls: [],
		...overrides,
	});
	return {
		...image,
		native: { ...image.native, ...nativeOverrides },
	};
}

describe("Test262 VM definition merger", () => {
	it("retains one shared semantic world and rejects mixed facts", () => {
		const semanticProtectors: NativePlan["semanticProtectors"] = [
			{
				family: "array-elements",
				guard: {
					dependencies: [{ kind: "epoch", family: "array-elements" }],
					obligations: ["fallback"],
				},
			},
		];
		const merged = mergeProgramImages([
			definition({}, { semanticProtectors }),
			definition({}, { semanticProtectors }),
		]).definition;
		expect(merged.native.semanticProtectors).toEqual(semanticProtectors);
		expect(merged.native.semanticProtectors).not.toBe(semanticProtectors);

		expect(() =>
			mergeProgramImages([definition({}, { semanticProtectors }), definition()]),
		).toThrow("semantic protector facts do not match");
		expect(() =>
			mergeProgramImages([
				definition({}, { semanticProtectors }),
				definition(
					{},
					{
						semanticProtectors: [
							{
								family: "array-elements",
								guard: {
									dependencies: [{ kind: "world", fact: "primordials.locked" }],
									obligations: ["fallback"],
								},
							},
						],
					},
				),
			]),
		).toThrow("semantic protector facts do not match");
	});

	it("clones and rebases every current definition-level index family", () => {
		const first = definition({
			functions: [
				vmFunction([{ opcode: "RETURN", value: 0 }]),
				vmFunction([{ opcode: "RETURN", value: 0 }]),
			],
			functionCount: 2,
			stringConstants: [[65], [66]],
			globalCount: 3,
		});
		const indexed: Array<BytecodeInstruction> = [
			{ opcode: "CREATE_FUNCTION", dst: 0, functionIndex: 0 },
			{ opcode: "GUARD_FUNCTION_INDEX", dst: 0, callee: 1, functionIndex: 0 },
			{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 0, index: 0 },
			{ opcode: "STORE_CAPTURED", src: 0, ownerFunctionIndex: -2, index: 0 },
			{ opcode: "LOAD_GLOBAL", dst: 0, index: 0 },
			{ opcode: "STORE_GLOBAL", src: 0, index: 0 },
			{ opcode: "CREATE_STRING", dst: 0, stringIndex: 0 },
			{ opcode: "CREATE_BIGINT", dst: 0, bigintIndex: 0 },
			{ opcode: "INSTANTIATE_LITERAL_TEMPLATE", dst: 0, templateOffset: 0 },
			{
				opcode: "CREATE_OBJECT_SHAPED",
				dst: 0,
				count: 1,
				keyStringIndices: [0],
				valueRegisters: [1],
				shapeCacheIndex: 0,
			},
			{
				opcode: "CREATE_TEMPLATE_OBJECT",
				dst: 0,
				cacheSlot: 0,
				cookedIndices: [0, -1],
				rawIndices: [0, 0],
			},
			{ opcode: "CREATE_MODULE_NAMESPACE", dst: 0, nameIndices: [0], slots: [0] },
			{ opcode: "WITH_SET", found: 0, value: 1, nameStringIndex: 0 },
			{
				opcode: "INIT_GLOBAL_VARS",
				nameStringIndices: [0],
				declarationConfigurable: true,
			},
			{ opcode: "CREATE_PRIVATE_NAMES", ownerFunctionIndex: 0, capturedIndices: [0, 2] },
			{ opcode: "INIT_PRIVATE_FIELDS", object: 0, keyRegisters: [1, 2] },
			{
				opcode: "CALL",
				dst: 0,
				callee: 1,
				thisValue: 2,
				argumentCount: 0,
				arguments: [],
			},
			{
				opcode: "CONSTRUCT",
				dst: 0,
				callee: 1,
				argumentCount: 0,
				arguments: [],
			},
			{
				opcode: "BINARY",
				dst: 4,
				left: 1,
				right: 2,
				operator: "+",
			},
			{
				opcode: "LOAD_PROPERTY",
				dst: 0,
				object: 1,
				key: 4,
				icIndex: 0,
			},
			{
				opcode: "CREATE_OBJECT",
				dst: 3,
			},
			{
				opcode: "STORE_PROPERTY",
				object: 3,
				key: 4,
				value: 1,
				icIndex: 1,
			},
			{
				opcode: "LOAD_PROPERTY",
				dst: 0,
				object: 1,
				key: 2,
				icIndex: 2,
			},
			{
				opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
				dst: 0,
				object: 1,
				stringIndex: 0,
				icIndex: 3,
				candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 0 }],
			},
			{
				opcode: "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
				object: 1,
				value: 2,
				stringIndex: 0,
				icIndex: 4,
				candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 0 }],
			},
		];
		const secondFunction = vmFunction(indexed);
		const secondBase = definition({
			functions: [secondFunction],
			globalCount: 5,
			literalTemplateData: [8, 2, 5, 0, 6, 0, 9, 1, 10, 0, 5, 0],
			sourcePositions: [{ line: 2, column: 1, inlinedFunctionIndex: 0, callerPosId: 0 }],
			cjsModuleFunctionIndices: [0],
			precompiledLiteralShapes: [
				{ functionIndex: 0, shapeCacheIndex: 0, keyStringIndices: [0] },
			],
			hostInstalls: [
				{ installer: "install_test", exports: [{ name: "value", slot: 0 }] },
			],
		});
		const second = withNativeFunctionPlan(secondBase, 0, (plan) => ({
			...plan,
			instructions: plan.instructions
				.with(16, {
					kind: "call",
					directFunctionIndex: 0,
					directFunctionCall: true,
					directCallTargetFunctionIndex: 0,
				})
				.with(17, { kind: "construct", directFunctionIndex: 0 }),
		}));

		const { definition: merged, functionBases } = mergeProgramImages([first, second]);
		expect(functionBases).toEqual([0, 2]);
		expect(merged.runtime.functionCount).toBe(3);
		expect(merged.runtime.functions[2]!.nameStringIndex).toBe(2);
		expect(merged.runtime.functions[2]!.fileIndex).toBe(1);
		expect(merged.runtime.functions[2]!.positions[0]).toBe(1);
		expect(merged.runtime.sourcePositions[1]).toEqual({
			line: 2,
			column: 1,
			inlinedFunctionIndex: 2,
			callerPosId: 1,
		});
		expect(merged.runtime.cjsModuleFunctionIndices).toEqual([2]);
		expect(merged.runtime.hostInstalls[0]!.exports[0]!.slot).toBe(3);
		expect(merged.runtime.literalTemplateData.slice(2)).toEqual([
			8, 2, 5, 2, 6, 1, 9, 1, 10, 2, 5, 2,
		]);
		expect(merged.runtime.precompiledLiteralShapes).toEqual([
			{ functionIndex: 2, shapeCacheIndex: 0, keyStringIndices: [2] },
		]);

		const rebased = merged.runtime.functions[2]!.instructions;
		expect(rebased[0]).toMatchObject({ functionIndex: 2 });
		expect(rebased[1]).toMatchObject({ functionIndex: 2 });
		expect(rebased[2]).toMatchObject({ ownerFunctionIndex: 2 });
		expect(rebased[3]).toMatchObject({ ownerFunctionIndex: -2 });
		expect(rebased[4]).toMatchObject({ index: 3 });
		expect(rebased[5]).toMatchObject({ index: 3 });
		expect(rebased[6]).toMatchObject({ stringIndex: 2 });
		expect(rebased[7]).toMatchObject({ bigintIndex: 1 });
		expect(rebased[8]).toMatchObject({ templateOffset: 2 });
		expect(rebased[9]).toMatchObject({ keyStringIndices: [2], valueRegisters: [1] });
		expect(rebased[10]).toMatchObject({
			cacheSlot: 3,
			cookedIndices: [2, -1],
			rawIndices: [2, 2],
		});
		expect(rebased[11]).toMatchObject({ nameIndices: [2], slots: [3] });
		expect(rebased[12]).toMatchObject({ nameStringIndex: 2 });
		expect(rebased[13]).toMatchObject({
			nameStringIndices: [2],
			declarationConfigurable: true,
		});
		expect(rebased[14]).toMatchObject({
			ownerFunctionIndex: 2,
			capturedIndices: [0, 2],
		});
		expect(rebased[15]).toMatchObject({ object: 0, keyRegisters: [1, 2] });
		const rebasedNative = merged.native.functions[2]!.instructions;
		expect(rebasedNative[16]).toMatchObject({
			directFunctionIndex: 2,
			directFunctionCall: true,
			directCallTargetFunctionIndex: 2,
		});
		expect(rebasedNative[17]).toMatchObject({ directFunctionIndex: 2 });
		expect(rebased[18]).toMatchObject({ opcode: "BINARY", operator: "+" });
		expect(rebased.at(-2)).toMatchObject({
			opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
			stringIndex: 2,
			candidates: [{ shapeFunctionIndex: 2, shapeCacheIndex: 0, slot: 0 }],
		});
		expect(rebased.at(-1)).toMatchObject({
			opcode: "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
			stringIndex: 2,
			candidates: [{ shapeFunctionIndex: 2, shapeCacheIndex: 0, slot: 0 }],
		});
		expect(second.runtime.functions[0]!.instructions).toEqual(indexed);
	});

	it("rejects malformed definition counts and literal-template streams", () => {
		expect(() => mergeProgramImages([definition({ functionCount: 2 })])).toThrow(
			/functionCount/,
		);
		expect(() => mergeProgramImages([definition({ literalTemplateData: [5] })])).toThrow(
			/Truncated/,
		);
	});
});
