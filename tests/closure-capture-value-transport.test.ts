import { describe, expect, it } from "vitest";
import { BYTECODE_OPERATIONS } from "../src/compiler/target/bytecode-operation-spec.ts";
import {
	COMPILER_ARTIFACT_MAGIC,
	COMPILER_ARTIFACT_VERSION,
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { emitProgramImage } from "../src/compiler/target/emit-program-image.ts";
import type { NativeCaptureAccessPlan } from "../src/compiler/target/lower-native-captures.ts";
import {
	lowerNativeStorage,
	validateNativeStorage,
} from "../src/compiler/target/lower-native-storage.ts";
import {
	deserializeRuntimeImage,
	readRuntimeImage,
	readRuntimeFunction,
	serializeRuntimeImage,
	Writer,
} from "../src/compiler/target/program-image-codec.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
	ClosureCaptureValue,
} from "../src/compiler/target/runtime-image.ts";
import { testProgramImage } from "./helpers/program-image.ts";

function captureImage(copied = true) {
	const child: BytecodeFunction = {
		nameStringIndex: -1,
		isGenerator: false,
		isAsync: false,
		parameterCount: 0,
		mappedArguments: false,
		mappedArgumentSlots: [],
		length: 0,
		registerCount: 2,
		capturedCount: 0,
		closureCaptureOwners: [1],
		closureCaptureValues: [
			{ ownerFunctionIndex: 1, capturedIndex: 0 },
			{ ownerFunctionIndex: 1, capturedIndex: 1 },
		],
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
			{ opcode: "LOAD_CAPTURED", dst: 0, ownerFunctionIndex: 1, index: 0 },
			{ opcode: "LOAD_CAPTURED", dst: 1, ownerFunctionIndex: 1, index: 1 },
			{ opcode: "RETURN", value: 1 },
		],
		handlers: [],
		fileIndex: 0,
		positions: [0, 0, 0],
	};
	if (!copied) child.closureCaptureValues = undefined;
	const owner: BytecodeFunction = {
		...child,
		capturedCount: 2,
		closureCaptureOwners: [],
		closureCaptureValues: undefined,
		instructions: [
			{ opcode: "CREATE_UNDEFINED", dst: 0 },
			{ opcode: "RETURN", value: 0 },
		],
		positions: [0, 0],
	};
	return testProgramImage({
		entrypointPath: "capture-values.js",
		functionCount: 2,
		functions: [child, owner],
		stringConstants: [],
		bigintConstants: [],
		literalTemplateData: [],
		precompiledLiteralShapes: [],
		globalCount: 0,
		files: ["capture-values.js"],
		sourcePositions: [{ line: 1, column: 0 }],
		cjsModuleFunctionIndices: [],
		hostInstalls: [],
	});
}

function replaceFirstCaptureValues(bytes: Uint8Array, record: Uint8Array): Uint8Array {
	const { reader } = readRuntimeImage(
		bytes,
		COMPILER_ARTIFACT_MAGIC,
		COMPILER_ARTIFACT_VERSION,
	);
	const bodyCount = reader.count(1);
	for (let index = 0; index < bodyCount; index++) readRuntimeFunction(reader);
	expect(reader.u32()).toBe(0);
	expect(reader.u32()).toBe(2);
	expect(reader.u8()).toBe(1);
	expect(reader.i32Array()).toEqual([1]);
	const start = bytes.length - reader.remaining();
	expect(reader.u8()).toBe(1);
	const count = reader.u32();
	for (let index = 0; index < count; index++) {
		reader.i32();
		reader.i32();
	}
	const end = bytes.length - reader.remaining();
	return Uint8Array.from([
		...bytes.subarray(0, start),
		...record,
		...bytes.subarray(end),
	]);
}

function captureRecord(values: ReadonlyArray<ClosureCaptureValue>): Uint8Array {
	const writer = new Writer();
	writer.u8(1);
	writer.u32(values.length);
	for (const value of values) {
		writer.i32(value.ownerFunctionIndex);
		writer.i32(value.capturedIndex);
	}
	return writer.finish();
}

const invalidLayouts: Array<[string, Array<ClosureCaptureValue>]> = [
	["empty", []],
	[
		"oversized",
		Array.from({ length: 17 }, (_, capturedIndex) => ({
			ownerFunctionIndex: 1,
			capturedIndex,
		})),
	],
	["negative owner", [{ ownerFunctionIndex: -1, capturedIndex: 0 }]],
	["missing owner", [{ ownerFunctionIndex: 2, capturedIndex: 0 }]],
	["own activation", [{ ownerFunctionIndex: 0, capturedIndex: 0 }]],
	["negative slot", [{ ownerFunctionIndex: 1, capturedIndex: -1 }]],
	["missing slot", [{ ownerFunctionIndex: 1, capturedIndex: 2 }]],
	[
		"duplicate slot",
		[
			{ ownerFunctionIndex: 1, capturedIndex: 0 },
			{ ownerFunctionIndex: 1, capturedIndex: 0 },
		],
	],
	[
		"unsorted slots",
		[
			{ ownerFunctionIndex: 1, capturedIndex: 1 },
			{ ownerFunctionIndex: 1, capturedIndex: 0 },
		],
	],
	["uncovered load", [{ ownerFunctionIndex: 1, capturedIndex: 0 }]],
];

describe("immutable closure capture artifact transport", () => {
	it("checks copied capture descriptors against both independently stored bodies", () => {
		const bytes = Buffer.from(serializeCompilerArtifact(captureImage()));
		const writer = new Writer();
		writer.u8(BYTECODE_OPERATIONS.indexOf("LOAD_CAPTURED"));
		writer.i32(0);
		writer.i32(1);
		writer.i32(0);
		const payload = Buffer.from(writer.finish());
		const following = new Writer();
		following.u8(BYTECODE_OPERATIONS.indexOf("LOAD_CAPTURED"));
		following.i32(1);
		following.i32(1);
		following.i32(1);
		following.u8(BYTECODE_OPERATIONS.indexOf("RETURN"));
		following.i32(1);
		const body = Buffer.concat([payload, Buffer.from(following.finish())]);
		const vm = bytes.indexOf(body);
		const native = bytes.indexOf(body, vm + body.length);
		expect(vm).toBeGreaterThanOrEqual(0);
		expect(native).toBeGreaterThan(vm);
		for (const offset of [vm, native]) {
			const invalid = Buffer.from(bytes);
			const replacement = new Writer();
			replacement.u8(BYTECODE_OPERATIONS.indexOf("LOAD_CAPTURED"));
			replacement.i32(0);
			replacement.i32(1);
			replacement.i32(2);
			invalid.set(replacement.finish(), offset);
			expect(() => deserializeCompilerArtifact(invalid)).toThrow(
				/uncovered closure capture value load/,
			);
		}
	});
	it.each(["closureCaptureOwners", "closureCaptureValues"] as const)(
		"rejects mismatched native and VM %s before caching or emitting C",
		(key) => {
			const image = captureImage();
			const native = image.native.functions[0]!;
			const invalid = {
				...image,
				native: {
					...image.native,
					functions: [
						{ ...native, body: { ...native.body, [key]: undefined } },
						...image.native.functions.slice(1),
					],
				},
			};
			expect(() => serializeCompilerArtifact(invalid)).toThrow(/closure capture .* ABI/);
			expect(() => emitProgramImage(invalid, { compiled: true })).toThrow(
				/closure capture .* ABI/,
			);
		},
	);
	it("round-trips shared descriptors while portable bytecode retains lexical lookup", () => {
		const image = captureImage();
		const bytes = serializeCompilerArtifact(image);
		const restored = deserializeCompilerArtifact(bytes);
		expect(restored.runtime.functions[0]!.closureCaptureValues).toEqual(
			image.runtime.functions[0]!.closureCaptureValues,
		);
		expect(restored.runtime.functions[1]!.closureCaptureValues).toBeUndefined();
		expect(serializeCompilerArtifact(restored)).toEqual(bytes);
		const portable = deserializeRuntimeImage(serializeRuntimeImage(image.runtime));
		expect(portable.functions.every((fn) => fn.closureCaptureValues === undefined)).toBe(
			true,
		);
		expect(portable.functions[0]!.instructions).toEqual(
			image.runtime.functions[0]!.instructions,
		);
	});

	it.each(invalidLayouts)("rejects %s when encoding and decoding", (_name, values) => {
		const image = captureImage();
		const bytes = serializeCompilerArtifact(image);
		image.runtime.functions[0]!.closureCaptureValues = values;
		expect(() => serializeCompilerArtifact(image)).toThrow(/closure capture value/);
		expect(() =>
			deserializeCompilerArtifact(
				replaceFirstCaptureValues(bytes, captureRecord(values)),
			),
		).toThrow(/closure capture value/);
	});

	it.each([
		{ ownerFunctionIndex: 1.5, capturedIndex: 0 },
		{ ownerFunctionIndex: Number.NaN, capturedIndex: 0 },
		{ ownerFunctionIndex: 1, capturedIndex: 0.5 },
		{ ownerFunctionIndex: 1, capturedIndex: Number.POSITIVE_INFINITY },
	])("rejects a noninteger descriptor %j", (value) => {
		const image = captureImage();
		image.runtime.functions[0]!.closureCaptureValues = [value];
		expect(() => serializeCompilerArtifact(image)).toThrow(
			"invalid closure capture values",
		);
	});

	it("rejects an unknown value layout tag", () => {
		const bytes = serializeCompilerArtifact(captureImage());
		expect(() =>
			deserializeCompilerArtifact(replaceFirstCaptureValues(bytes, Uint8Array.of(2))),
		).toThrow("invalid closure capture values tag");
	});

	it.each([undefined, []])("requires owner requirements %j", (owners) => {
		const image = captureImage();
		image.runtime.functions[0]!.closureCaptureOwners = owners;
		expect(() => serializeCompilerArtifact(image)).toThrow(
			"invalid closure capture values",
		);
	});

	it("rejects an unread descriptor", () => {
		const image = captureImage();
		image.runtime.functions[0]!.instructions[1] = { opcode: "MOVE", dst: 1, src: 0 };
		expect(() => serializeCompilerArtifact(image)).toThrow(
			"unread closure capture value",
		);
	});

	it.each<Partial<BytecodeFunction>>([
		{ strict: false },
		{ isAsync: true },
		{ isGenerator: true },
		{ isClassConstructor: true },
		{ capturedCount: 1 },
	])("rejects unsupported function metadata %j", (metadata) => {
		const image = captureImage();
		Object.assign(image.runtime.functions[0]!, metadata);
		expect(() => serializeCompilerArtifact(image)).toThrow(
			"invalid closure capture values",
		);
	});

	it.each<BytecodeInstruction>([
		{ opcode: "STORE_CAPTURED", ownerFunctionIndex: 1, index: 0, src: 0 },
		{ opcode: "CREATE_FUNCTION", functionIndex: 1, dst: 0 },
		{ opcode: "CREATE_PRIVATE_NAMES", ownerFunctionIndex: 1, capturedIndices: [0] },
		{ opcode: "ENV_PUSH", scopeId: -2, slotCount: 1 },
		{ opcode: "ENV_COPY", scopeId: -2, slotCount: 1 },
		{ opcode: "ENV_POP" },
		{ opcode: "WITH_ENTER", object: 0 },
		{ opcode: "WITH_EXIT" },
	])("rejects a non-leaf or mutable capture operation %j", (instruction) => {
		const image = captureImage();
		image.runtime.functions[0]!.instructions[2] = instruction;
		expect(() => serializeCompilerArtifact(image)).toThrow(
			"invalid closure capture value body",
		);
	});
});

describe("persisted native capture access contract", () => {
	it("round-trips canonical and typed entry choices while preserving copied display order", () => {
		const image = captureImage();
		const fn = image.native.functions[0]!;
		const selected = lowerNativeStorage({
			...image,
			native: {
				...image.native,
				functions: [
					{
						...fn,
						directEntries: [
							{
								id: 0,
								parameterRepresentations: [],
								resultRepresentation: "boxed",
								registerRepresentations: fn.registerRepresentations,
								gc: {
									safepoints: fn.gc.safepoints.map((point) => ({
										...point,
										kind: "operation" as const,
									})),
								},
							},
						],
					},
					...image.native.functions.slice(1),
				],
			},
		});
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(selected));
		const plan = restored.native.functions[0]!;
		expect(plan.storage!.captures.copiedValues).toEqual([
			{ ownerFunctionIndex: 1, capturedIndex: 0 },
			{ ownerFunctionIndex: 1, capturedIndex: 1 },
		]);
		expect(plan.directEntries[0]!.storage!.captures).toEqual(plan.storage!.captures);
	});

	it.each([
		["omitted owner", { owners: [] }],
		["incorrect ordinal", { owners: [{ ownerFunctionIndex: 1, lookupIndex: -1 }] }],
		["incorrect initializer", { initialization: "lookup" }],
		["missing layout", { layout: [] }],
		["forged environment ownership", { ownsEnvironment: true }],
	] satisfies Array<[string, Partial<NativeCaptureAccessPlan>]>)(
		"rejects %s independently of serialized renderer choices",
		(_name, change) => {
			const native = captureImage(false).native.functions[0]!;
			const forged = {
				...native,
				storage: {
					...native.storage!,
					captures: { ...native.storage!.captures, ...change },
				},
			};
			expect(() => validateNativeStorage(forged)).toThrow(
				/invalid or stale storage plan/,
			);
		},
	);

	it("rejects stale copied values and rederives choices after capture metadata changes", () => {
		const image = captureImage();
		image.native.functions[0]!.body.closureCaptureValues = undefined;
		expect(() => validateNativeStorage(image.native.functions[0]!)).toThrow(
			/invalid or stale storage plan/,
		);
		const updated = lowerNativeStorage(image);
		expect(() => validateNativeStorage(updated.native.functions[0]!)).not.toThrow();
		expect(updated.native.functions[0]!.storage!.captures.owners).toEqual([
			{ ownerFunctionIndex: 1, lookupIndex: 0 },
		]);
		expect(() => emitProgramImage(updated, { compiled: true })).not.toThrow();
	});
});
