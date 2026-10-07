import { describe, expect, it } from "vitest";
import {
	COMPILER_ARTIFACT_MAGIC,
	COMPILER_ARTIFACT_VERSION,
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	readRuntimeImage,
	readRuntimeFunction,
} from "../src/compiler/target/program-image-codec.ts";
import type { Reader } from "../src/compiler/target/program-image-codec.ts";
import type { NativeDirectEntryPlan } from "../src/compiler/target/program-image.ts";
import type { BytecodeFunction } from "../src/compiler/target/runtime-image.ts";
import { mergeProgramImages } from "../src/test262/program-image-merge.ts";
import { testProgramImage, withNativeFunctionPlan } from "./helpers/program-image.ts";

function callGraphImage() {
	const caller: BytecodeFunction = {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount: 1,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 1,
		registerCount: 4,
		capturedCount: 0,
		strict: true,
		needsArguments: false,
		argumentSnapshotCount: 0,
		argumentSnapshotPlan: [],
		isDerivedConstructor: false,
		isClassConstructor: false,
		constructorSlotReserve: 0,
		hasPrototype: false,
		propertyIcCount: 0,
		literalShapeCount: 0,
		instructions: [
			{ opcode: "CREATE_FUNCTION", dst: 1, functionIndex: 1 },
			{ opcode: "CREATE_UNDEFINED", dst: 2 },
			{
				opcode: "CALL",
				dst: 3,
				callee: 1,
				thisValue: 2,
				arguments: [0],
				argumentCount: 1,
			},
			{ opcode: "RETURN", value: 3 },
		],
		handlers: [],
		fileIndex: 0,
		positions: [0, 0, 0, 0],
	};
	const target: BytecodeFunction = {
		...caller,
		registerCount: 1,
		instructions: [{ opcode: "RETURN", value: 0 }],
		positions: [0],
	};
	let image = testProgramImage({
		entrypointPath: "call-graph.js",
		functionCount: 2,
		functions: [caller, target],
		stringConstants: [],
		bigintConstants: [],
		literalTemplateData: [],
		precompiledLiteralShapes: [],
		globalCount: 0,
		files: ["call-graph.js"],
		sourcePositions: [{ line: 1, column: 0 }],
		cjsModuleFunctionIndices: [],
		hostInstalls: [],
	});
	image = withNativeFunctionPlan(image, 0, (plan) => ({
		...plan,
		directEntries: [
			{
				id: 0,
				parameterRepresentations: ["number"],
				resultRepresentation: "number",
				registerRepresentations: ["number", "boxed", "boxed", "number"],
				callOverrides: [{ instructionIp: 2, functionIndex: 1, entryId: 0 }],
				gc: {
					safepoints: [
						{
							kind: "operation",
							instructionIp: 2,
							rootRegisters: [1, 2],
							incomingRootRegisters: [1, 2],
							outgoingRootRegisters: [],
						},
					],
				},
			},
		],
	}));
	return withNativeFunctionPlan(image, 1, (plan) => ({
		...plan,
		directEntries: [
			{
				id: 0,
				parameterRepresentations: ["number"],
				resultRepresentation: "number",
				registerRepresentations: ["number"],
				gc: { safepoints: [] },
			},
		],
	}));
}

function skipStorageWithoutFastPaths(reader: Reader): void {
	reader.u32();
	for (let index = 0; index < 9; index++) reader.i32Array();
	expect(reader.u8()).toBe(0);
	for (let index = 0; index < 5; index++) expect(reader.u32()).toBe(0);
	for (let index = 0; index < 3; index++) expect(reader.u8()).toBe(0);
	expect(reader.u32()).toBe(0);
}

function firstOverrideOffset(bytes: Uint8Array): number {
	const { reader } = readRuntimeImage(
		bytes,
		COMPILER_ARTIFACT_MAGIC,
		COMPILER_ARTIFACT_VERSION,
	);
	const bodyCount = reader.count(1);
	for (let index = 0; index < bodyCount; index++) readRuntimeFunction(reader);
	expect(reader.u32()).toBe(0); // Semantic protectors.
	expect(reader.u32()).toBe(2); // Functions.
	expect(reader.u8()).toBe(0); // Unknown closure layout.
	expect(reader.u8()).toBe(0); // No immutable value captures.
	reader.i32Array();
	skipStorageWithoutFastPaths(reader);
	const safepointCount = reader.u32();
	for (let index = 0; index < safepointCount; index++) {
		reader.u8();
		reader.i32();
		reader.i32Array();
		reader.i32Array();
		reader.i32Array();
	}
	const registerCount = reader.u32();
	for (let index = 0; index < registerCount; index++) reader.u8();
	expect(reader.u32()).toBe(0); // Literal switches.
	expect(reader.u32()).toBe(0); // Field calls.
	expect(reader.u8()).toBe(0); // Canonical body retained.
	expect(reader.u32()).toBe(1); // Direct entries.
	skipStorageWithoutFastPaths(reader);
	expect(reader.u32()).toBe(0); // Entry identity.
	reader.u8(); // Result representation.
	expect(reader.u32()).toBe(1); // Parameter count.
	reader.u8(); // Parameter representation.
	expect(reader.i32()).toBe(-1); // No argument slice specialization.
	expect(reader.u32()).toBe(0); // Field keys.
	expect(reader.u32()).toBe(0); // Field loads.
	expect(reader.u32()).toBe(0); // Constant booleans.
	expect(reader.u32()).toBe(0); // Operator inputs.
	expect(reader.u32()).toBe(1); // Outgoing call overrides.
	return bytes.length - reader.remaining();
}

describe("specialized call graph metadata transport", () => {
	it("round-trips an outgoing scalar call while retaining its canonical dynamic call", () => {
		const image = callGraphImage();
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[0]!.directEntries).toEqual(
			image.native.functions[0]!.directEntries,
		);
		expect(restored.native.functions[0]!.instructions[2]).toBeUndefined();
		expect(restored.runtime.functions[0]!.instructions[2]).toEqual(
			image.runtime.functions[0]!.instructions[2],
		);
		expect(serializeCompilerArtifact(restored)).toEqual(serializeCompilerArtifact(image));
	});

	it("rebases outgoing target functions and preserves per-function entry identities", () => {
		const image = callGraphImage();
		const { image: merged } = mergeProgramImages([image, image]);
		const first = merged.native.functions[0]!.directEntries[0]!.callOverrides;
		const second = merged.native.functions[2]!.directEntries[0]!.callOverrides;
		expect(first).toEqual([{ instructionIp: 2, functionIndex: 1, entryId: 0 }]);
		expect(second).toEqual([{ instructionIp: 2, functionIndex: 3, entryId: 0 }]);
		expect(first).not.toBe(image.native.functions[0]!.directEntries[0]!.callOverrides);
		expect(
			deserializeCompilerArtifact(serializeCompilerArtifact(merged)).native.functions[2]!
				.directEntries[0]!.callOverrides,
		).toEqual(second);
	});

	it.each([
		[{ instructionIp: 2, functionIndex: 2, entryId: 0 }],
		[{ instructionIp: 2, functionIndex: 1, entryId: 1 }],
		[{ instructionIp: 0, functionIndex: 1, entryId: 0 }],
		[
			{ instructionIp: 2, functionIndex: 1, entryId: 0 },
			{ instructionIp: 2, functionIndex: 1, entryId: 0 },
		],
	])(
		"rejects absent target ABIs, non-call sites, and conflicting overrides: %j",
		(...callOverrides) => {
			const image = withNativeFunctionPlan(callGraphImage(), 0, (plan) => ({
				...plan,
				directEntries: plan.directEntries.map((entry) => ({ ...entry, callOverrides })),
			}));
			expect(() => serializeCompilerArtifact(image)).toThrow(/call override/);
		},
	);

	it("preserves guarded specialized calls across artifact boundaries", () => {
		const image = withNativeFunctionPlan(callGraphImage(), 0, (plan) => ({
			...plan,
			directEntries: plan.directEntries.map((entry): NativeDirectEntryPlan => ({
				...entry,
				callOverrides: entry.callOverrides!.map((call) => ({ ...call, guarded: true })),
			})),
		}));
		expect(
			deserializeCompilerArtifact(serializeCompilerArtifact(image)).native.functions[0]!
				.directEntries[0]!.callOverrides,
		).toEqual(image.native.functions[0]!.directEntries[0]!.callOverrides);
	});

	it.each([
		{ argumentRepresentations: ["number", "number"] as const },
		{ fieldParameters: { keys: [0], loads: [] } },
	])("rejects outgoing calls that cannot supply their target ABI: %j", (target) => {
		const image = withNativeFunctionPlan(callGraphImage(), 1, (plan) => ({
			...plan,
			directEntries: plan.directEntries.map((entry) => ({ ...entry, ...target })),
		}));
		expect(() => serializeCompilerArtifact(image)).toThrow(
			/call override names an incompatible ABI/,
		);
	});

	it.each([
		{ field: "instruction", offset: 0, value: 0 },
		{ field: "target function", offset: 1, value: 2 },
		{ field: "target entry", offset: 2, value: 1 },
		{ field: "guard", offset: 3, value: 2 },
	])("rejects corrupt serialized $field metadata", ({ offset, value }) => {
		const bytes = serializeCompilerArtifact(callGraphImage());
		bytes[firstOverrideOffset(bytes) + offset] = value;
		expect(() => deserializeCompilerArtifact(bytes)).toThrow(/call (override|guard)/);
	});
});
