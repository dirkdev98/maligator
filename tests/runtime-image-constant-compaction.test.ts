import { describe, expect, it } from "vitest";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToRuntimeImage } from "../src/compiler/pipeline/compile-runtime-core.ts";
import type { VmStringSplitProjectionRegion } from "../src/compiler/target/program-image.ts";
import { compactProgramImageConstants } from "../src/compiler/target/program-image.ts";
import {
	compactRuntimeImageConstants,
	decodeVmValueOperand,
	encodeVmValueOperand,
} from "../src/compiler/target/runtime-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
	RuntimeImage,
} from "../src/compiler/target/runtime-image.ts";
import { testProgramImage, withNativeFunctionPlan } from "./helpers/program-image.ts";

function units(value: string): Array<number> {
	return value.split("").map((unit) => unit.charCodeAt(0));
}

function vmFunction(instructions: Array<BytecodeInstruction>): BytecodeFunction {
	return {
		nameStringIndex: 2,
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
		literalShapeCount: 1,
		instructions,
		handlers: [],
		fileIndex: 0,
		positions: [],
	};
}

function runtimeFixture(): RuntimeImage {
	const instructions: Array<BytecodeInstruction> = [
		{ opcode: "CREATE_STRING", dst: 0, stringIndex: 2 },
		{ opcode: "CREATE_BIGINT", dst: 1, bigintIndex: 1 },
		{ opcode: "INSTANTIATE_LITERAL_TEMPLATE", dst: 2, templateOffset: 2 },
		{
			opcode: "CREATE_OBJECT_SHAPED",
			dst: 3,
			count: 1,
			keyStringIndices: [5],
			valueRegisters: [0],
			shapeCacheIndex: 0,
		},
		{
			opcode: "CALL",
			dst: 4,
			callee: encodeVmValueOperand(0, { kind: "string", index: 4 }),
			thisValue: encodeVmValueOperand(0, { kind: "string", index: 5 }),
			argumentCount: 1,
			arguments: [encodeVmValueOperand(0, { kind: "string", index: 6 })],
		},
		{
			opcode: "LOAD_PROPERTY_STATIC",
			dst: 5,
			object: 3,
			stringIndex: 7,
			icIndex: 0,
		},
		{ opcode: "CREATE_MODULE_NAMESPACE", dst: 6, nameIndices: [5], slots: [0] },
		{
			opcode: "CREATE_TEMPLATE_OBJECT",
			dst: 6,
			cacheSlot: 0,
			cookedIndices: [4, -1],
			rawIndices: [5, 7],
		},
		{ opcode: "LOAD_UNDECLARED", dst: 6, nameStringIndex: 6 },
		{
			opcode: "INIT_GLOBAL_VARS",
			nameStringIndices: [2, 7],
			declarationConfigurable: false,
		},
		{ opcode: "CREATE_BIGINT", dst: 6, bigintIndex: 3 },
		{ opcode: "INSTANTIATE_LITERAL_TEMPLATE", dst: 6, templateOffset: 8 },
		{
			opcode: "INIT_GLOBAL_VARS",
			nameStringIndices: [8],
			declarationConfigurable: false,
		},
		{ opcode: "RETURN", value: 0 },
	];
	return {
		entrypointPath: "/fixture/input.js",
		functionCount: 1,
		functions: [vmFunction(instructions)],
		stringConstants: [
			units("dead-leading"),
			units("dead-template"),
			units("function"),
			units("dead-middle"),
			units("templated"),
			units("shape"),
			units("argument"),
			units("property"),
			units("property"),
		],
		bigintConstants: [10n, 20n, 30n, 30n],
		literalTemplateData: [5, 1, 8, 2, 5, 4, 6, 2, 8, 2, 5, 4, 6, 2],
		precompiledLiteralShapes: [
			{ functionIndex: 0, shapeCacheIndex: 0, keyStringIndices: [5] },
		],
		globalCount: 0,
		files: [],
		sourcePositions: [],
		cjsModuleFunctionIndices: [],
		hostInstalls: [],
	};
}

describe("RuntimeImage constant compaction", () => {
	it("retains only final VM consumers and densely rebases every pool", () => {
		const result = compactRuntimeImageConstants(runtimeFixture());
		expect(result.changed).toBe(true);
		expect(
			result.runtime.stringConstants.map((value) => String.fromCharCode(...value)),
		).toEqual(["function", "templated", "shape", "argument", "property"]);
		expect(result.runtime.bigintConstants).toEqual([20n, 30n]);
		expect(result.runtime.literalTemplateData).toEqual([8, 2, 5, 1, 6, 1]);

		const fn = result.runtime.functions[0]!;
		expect(fn.nameStringIndex).toBe(0);
		expect(fn.instructions[0]).toMatchObject({ opcode: "CREATE_STRING", stringIndex: 0 });
		expect(fn.instructions[1]).toMatchObject({ opcode: "CREATE_BIGINT", bigintIndex: 0 });
		expect(fn.instructions[2]).toMatchObject({
			opcode: "INSTANTIATE_LITERAL_TEMPLATE",
			templateOffset: 0,
		});
		expect(fn.instructions[3]).toMatchObject({
			opcode: "CREATE_OBJECT_SHAPED",
			keyStringIndices: [2],
		});
		const call = fn.instructions[4]!;
		if (call.opcode !== "CALL") throw new Error("missing call fixture");
		expect(decodeVmValueOperand(call.callee)).toEqual({
			kind: "string",
			index: 1,
		});
		expect(decodeVmValueOperand(call.thisValue)).toEqual({
			kind: "string",
			index: 2,
		});
		expect(decodeVmValueOperand(call.arguments[0]!)).toEqual({
			kind: "string",
			index: 3,
		});
		expect(fn.instructions[5]).toMatchObject({
			opcode: "LOAD_PROPERTY_STATIC",
			stringIndex: 4,
		});
		expect(fn.instructions[6]).toMatchObject({
			opcode: "CREATE_MODULE_NAMESPACE",
			nameIndices: [2],
		});
		expect(fn.instructions[7]).toMatchObject({
			opcode: "CREATE_TEMPLATE_OBJECT",
			cookedIndices: [1, -1],
			rawIndices: [2, 4],
		});
		expect(fn.instructions[8]).toMatchObject({
			opcode: "LOAD_UNDECLARED",
			nameStringIndex: 3,
		});
		expect(fn.instructions[9]).toMatchObject({
			opcode: "INIT_GLOBAL_VARS",
			nameStringIndices: [0, 4],
		});
		expect(fn.instructions[10]).toMatchObject({
			opcode: "CREATE_BIGINT",
			bigintIndex: 1,
		});
		expect(fn.instructions[11]).toMatchObject({
			opcode: "INSTANTIATE_LITERAL_TEMPLATE",
			templateOffset: 0,
		});
		expect(fn.instructions[12]).toMatchObject({
			opcode: "INIT_GLOBAL_VARS",
			nameStringIndices: [4],
		});
		expect(result.runtime.precompiledLiteralShapes[0]!.keyStringIndices).toEqual([2]);

		expect(result.report).toMatchObject({
			strings: { originalCount: 9, retainedCount: 5 },
			bigints: { originalCount: 4, retainedCount: 2 },
			literalTemplates: { originalWordCount: 14, retainedWordCount: 6 },
		});
		expect(
			result.report.strings.entries.find(({ index }) => index === 2)?.reasons,
		).toEqual(
			expect.arrayContaining([
				"function 0 nameStringIndex",
				"function 0 instruction 0 CREATE_STRING.stringIndex",
			]),
		);
		expect(
			result.report.strings.entries.find(({ index }) => index === 6)?.reasons,
		).toEqual(
			expect.arrayContaining([
				"function 0 instruction 4 CALL.arguments[0]",
				"function 0 instruction 8 LOAD_UNDECLARED.nameStringIndex",
			]),
		);
	});

	it("rebases the native String.split separator with the portable pool", () => {
		const definition = testProgramImage(runtimeFixture());
		const region: VmStringSplitProjectionRegion = {
			kind: "string-split-projection",
			license: {
				guard: {
					dependencies: [{ kind: "epoch", family: "watched-methods" }],
					obligations: ["fallback", "materialize"],
				},
				genericTwin: "retained",
				materialization: "whole-region",
				admission: { anchorIp: 0, mode: "stable" },
			},
			representation: "projected-elements",
			anchors: [],
			claimedIps: [],
			controlFlow: { ordinaryBlockIps: [], exceptionalHandlerIps: [] },
			cost: { score: 0, metadataOperations: 0 },
			propertyIp: 0,
			propertyPlacement: "in-place",
			splitIdentity: "runtime-guarded",
			callIp: 0,
			callee: 0,
			receiver: 0,
			separatorIp: 0,
			separatorStringIndex: 7,
			resultRegisters: [],
			loads: [],
		};
		const specialized = withNativeFunctionPlan(definition, 0, (plan) => ({
			...plan,
			specializations: [region],
		}));
		const result = compactProgramImageConstants(specialized);
		expect(result.changed).toBe(true);
		expect(result.definition.native.functions[0]!.specializations[0]).toMatchObject({
			kind: "string-split-projection",
			separatorStringIndex: 4,
		});
	});

	it("shares identical literal-template payloads across source sites", () => {
		const values = Array.from({ length: 20 }, (_value, index) => index).join(",");
		const source = `
			const first = [${values}];
			const second = [${values}];
			globalThis.values = [first, second];
		`;
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"literal-template-dedup.js",
			parseScript(source, { strict: false }),
		);
		const runtime = compileSemanticProgramToRuntimeImage(semantic);
		const offsets = runtime.functions.flatMap((fn) =>
			fn.instructions.flatMap((instruction) =>
				instruction.opcode === "INSTANTIATE_LITERAL_TEMPLATE"
					? [instruction.templateOffset]
					: [],
			),
		);
		expect(offsets).toHaveLength(2);
		expect(new Set(offsets)).toEqual(new Set([0]));
		expect(runtime.literalTemplateData).toHaveLength(42);
	});

	it("represents anonymous function names without a string constant", () => {
		const source = "globalThis.answer = 42;";
		const semantic = analyzeSourceAndRunSemanticAnalysis(
			source,
			"anonymous-name.js",
			parseScript(source, { strict: false }),
		);
		const runtime = compileSemanticProgramToRuntimeImage(semantic);

		expect(runtime.functions[0]!.nameStringIndex).toBe(-1);
		expect(runtime.stringConstants).not.toContainEqual([]);
	});
});
