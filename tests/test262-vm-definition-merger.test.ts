import { describe, expect, it } from "vitest";
import type { VmDefinition, VmFunction, VmInstruction } from "../src/lower-vm.ts";
import { mergeVmDefinitions } from "../src/test262/vm-definition-merge.ts";

function vmFunction(instructions: Array<VmInstruction>): VmFunction {
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
		instructions,
		handlers: [{ startIp: 0, endIp: 1, handlerIp: 1 }],
		fileIndex: 0,
		positions: instructions.map(() => 0),
		gcRootRegisters: [0, 2],
	};
}

function definition(overrides: Partial<VmDefinition> = {}): VmDefinition {
	const functions = overrides.functions ?? [vmFunction([{ opcode: "RETURN", value: 0 }])];
	return {
		entrypointPath: "input.js",
		functionCount: functions.length,
		functions,
		stringConstants: [[65]],
		bigintConstants: [1n],
		literalTemplateData: [8, 0],
		globalCount: 1,
		files: ["input.js"],
		sourcePositions: [{ line: 1, column: 0 }],
		cjsModuleFunctionIndices: [],
		hostInstalls: [],
		...overrides,
	};
}

describe("Test262 VM definition merger", () => {
	it("retains one shared semantic world and rejects mixed facts", () => {
		const semanticProtectors: NonNullable<VmDefinition["semanticProtectors"]> = [
			{
				family: "array-elements",
				guard: {
					dependencies: [{ kind: "epoch", family: "array-elements" }],
					obligations: ["fallback"],
				},
			},
		];
		const merged = mergeVmDefinitions([
			definition({ semanticProtectors }),
			definition({ semanticProtectors }),
		]).definition;
		expect(merged.semanticProtectors).toEqual(semanticProtectors);
		expect(merged.semanticProtectors).not.toBe(semanticProtectors);

		expect(() =>
			mergeVmDefinitions([definition({ semanticProtectors }), definition()]),
		).toThrow("semantic protector facts do not match");
		expect(() =>
			mergeVmDefinitions([
				definition({ semanticProtectors }),
				definition({
					semanticProtectors: [
						{
							family: "array-elements",
							guard: {
								dependencies: [{ kind: "world", fact: "primordials.locked" }],
								obligations: ["fallback"],
							},
						},
					],
				}),
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
		const indexed: Array<VmInstruction> = [
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
				directFunctionIndex: 0,
				directFunctionCall: true,
				directCallTargetFunctionIndex: 0,
			},
			{
				opcode: "CONSTRUCT",
				dst: 0,
				callee: 1,
				argumentCount: 0,
				arguments: [],
				directFunctionIndex: 0,
			},
			{
				opcode: "BINARY",
				dst: 0,
				left: 1,
				right: 2,
				operator: "+",
				nativeFiniteString: { minimum: 0, stringIndices: [0] },
			},
			{
				opcode: "LOAD_PROPERTY",
				dst: 0,
				object: 1,
				key: 2,
				icIndex: 0,
				nativeFiniteKey: { minimum: 0, ordinal: 2, stringIndices: [0] },
			},
			{
				opcode: "CREATE_OBJECT",
				dst: 3,
			},
			{
				opcode: "STORE_PROPERTY",
				object: 3,
				key: 2,
				value: 1,
				icIndex: 1,
				nativeFiniteKey: { minimum: 0, ordinal: 2, stringIndices: [0] },
			},
			{
				opcode: "LOAD_PROPERTY",
				dst: 0,
				object: 1,
				key: 2,
				icIndex: 2,
				nativeClosedGlobalTable: {
					baseIndex: 0,
					stateIndex: 4,
					mask: 3,
					direct: true,
					guard: {
						dependencies: [{ kind: "epoch", family: "array-elements" }],
						obligations: ["fallback", "materialize"],
					},
				},
			},
		];
		const secondFunction = vmFunction(indexed);
		secondFunction.regions = [
			{
				kind: "finite-object-construction",
				license: {
					guard: { dependencies: [], obligations: ["fallback", "materialize"] },
					genericTwin: "retained",
					materialization: "on-demand",
				},
				representation: "finite-key-object-slots",
				anchors: [20, 21],
				claimedIps: [20, 21],
				controlFlow: { ordinaryBlockIps: [0], exceptionalHandlerIps: [] },
				cost: { score: 1, metadataOperations: 2 },
				allocationIp: 20,
				storeIp: 21,
				icIndex: 1,
				numberGuards: [2],
				keyStringIndices: [0],
				virtualRecord: false,
				accessIps: [],
				runtimeGuard: "number-leaves-and-prototype-shape",
			},
		];
		const second = definition({
			functions: [secondFunction],
			globalCount: 5,
			literalTemplateData: [8, 2, 5, 0, 6, 0, 9, 1, 10, 0, 5, 0],
			sourcePositions: [{ line: 2, column: 1, inlinedFunctionIndex: 0, callerPosId: 0 }],
			cjsModuleFunctionIndices: [0],
			hostInstalls: [
				{ installer: "install_test", exports: [{ name: "value", slot: 0 }] },
			],
		});

		const { definition: merged, functionBases } = mergeVmDefinitions([first, second]);
		expect(functionBases).toEqual([0, 2]);
		expect(merged.functionCount).toBe(3);
		expect(merged.functions[2]!.nameStringIndex).toBe(2);
		expect(merged.functions[2]!.fileIndex).toBe(1);
		expect(merged.functions[2]!.positions[0]).toBe(1);
		expect(merged.sourcePositions[1]).toEqual({
			line: 2,
			column: 1,
			inlinedFunctionIndex: 2,
			callerPosId: 1,
		});
		expect(merged.cjsModuleFunctionIndices).toEqual([2]);
		expect(merged.hostInstalls[0]!.exports[0]!.slot).toBe(3);
		expect(merged.literalTemplateData.slice(2)).toEqual([
			8, 2, 5, 2, 6, 1, 9, 1, 10, 2, 5, 2,
		]);

		const rebased = merged.functions[2]!.instructions;
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
		expect(rebased[16]).toMatchObject({ directFunctionIndex: 2 });
		expect(rebased[16]).toMatchObject({
			directFunctionCall: true,
			directCallTargetFunctionIndex: 2,
		});
		expect(rebased[17]).toMatchObject({ directFunctionIndex: 2 });
		expect(rebased[18]).toMatchObject({
			nativeFiniteString: { minimum: 0, stringIndices: [2] },
		});
		expect(rebased[19]).toMatchObject({
			nativeFiniteKey: { minimum: 0, ordinal: 2, stringIndices: [2] },
		});
		expect(merged.functions[2]!.regions?.[0]).toMatchObject({
			kind: "finite-object-construction",
			icIndex: 1,
			numberGuards: [2],
			keyStringIndices: [2],
		});
		expect(rebased[21]).toMatchObject({
			nativeFiniteKey: { minimum: 0, ordinal: 2, stringIndices: [2] },
		});
		expect(rebased[22]).toMatchObject({
			nativeClosedGlobalTable: {
				baseIndex: 3,
				stateIndex: 7,
				mask: 3,
				direct: true,
			},
		});
		expect(second.functions[0]!.instructions).toEqual(indexed);
	});

	it("rejects malformed definition counts and literal-template streams", () => {
		expect(() => mergeVmDefinitions([definition({ functionCount: 2 })])).toThrow(
			/functionCount/,
		);
		expect(() => mergeVmDefinitions([definition({ literalTemplateData: [5] })])).toThrow(
			/Truncated/,
		);
	});
});
