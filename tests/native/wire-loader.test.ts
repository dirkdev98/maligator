import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { stripCompactTypes } from "../../src/compiler/frontend/compact-type-strip.ts";
import {
	compileEntrypoint,
	compileEntrypointToBuffer,
} from "../../src/compiler/pipeline/compile-program.ts";
import { knownBuiltinErrorNames } from "../../src/compiler/shared/known-builtin-errors.ts";
import {
	serializeRuntimeImage,
	WIRE_OPCODES,
} from "../../src/compiler/target/program-image-codec.ts";
import {
	encodeVmValueOperand,
	VM_GUARDED_BUILTIN_CALL_OPERATIONS,
	VM_MATH_BINARY_NUMBER_OPERATIONS,
	VM_MATH_UNARY_NUMBER_OPERATIONS,
} from "../../src/compiler/target/runtime-image.ts";
import type {
	RuntimeImage,
	BytecodeFunction,
	BytecodeInstruction,
} from "../../src/compiler/target/runtime-image.ts";
import { buildLoadDriver } from "../../src/local-build.ts";

const fn: BytecodeFunction = {
	nameStringIndex: -1,
	isGenerator: false,
	isAsync: false,
	parameterCount: 0,
	mappedArguments: false,
	mappedArgumentSlots: [],
	length: 0,
	registerCount: 1,
	capturedCount: 0,
	strict: true,
	needsArguments: false,
	argumentSnapshotCount: 0,
	argumentSnapshotPlan: [],
	isDerivedConstructor: false,
	isClassConstructor: false,
	constructorSlotReserve: 0,
	hasPrototype: false,
	literalShapeCount: 1,
	instructions: [
		{
			opcode: "CREATE_OBJECT_SHAPED",
			dst: 0,
			count: 1,
			keyStringIndices: [0],
			valueRegisters: [0],
			shapeCacheIndex: 0,
		},
		{ opcode: "RETURN", value: 0 },
	],
	handlers: [],
	fileIndex: 0,
	positions: [],
};

const definition: RuntimeImage = {
	entrypointPath: "/fixture/entry.mjs",
	functionCount: 1,
	functions: [fn],
	stringConstants: [],
	bigintConstants: [],
	literalTemplateData: [],
	precompiledLiteralShapes: [],
	globalCount: 0,
	files: [],
	sourcePositions: [],
	cjsModuleFunctionIndices: [],
	hostInstalls: [],
};

const sourceEntryFieldSize =
	1 + new TextEncoder().encode(definition.entrypointPath).length;
const afterSourceEntry = (offset: number): number => offset + sourceEntryFieldSize;

describe("wire loader side-data validation", () => {
	let driver: string;
	let directory: string;

	beforeAll(() => {
		driver = buildLoadDriver(false, {
			kind: "source",
			sourceDirectory: path.resolve("src"),
			entrypoint: path.resolve("src/compiler/pipeline/eval-compiler-entry.mts"),
			bake: () =>
				compileEntrypointToBuffer(
					path.resolve("src/compiler/pipeline/eval-compiler-entry.mts"),
					{
						intrinsicGlobalReads: true,
						stripTypes: stripCompactTypes,
					},
				),
		});
		directory = mkdtempSync(path.join(tmpdir(), "mal-wire-loader-"));
	});

	function rejectsMutation(name: string, offset: number, encodedValue: number): void {
		const wire = serializeRuntimeImage(definition, { debugInfo: false });
		wire[offset] = encodedValue;
		rejectsWire(name, wire);
	}

	function rejectsWire(name: string, wire: Uint8Array): void {
		const wirePath = path.join(directory, `${name}.malw`);
		writeFileSync(wirePath, wire);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("truncated or corrupt buffer");
	}

	function acceptsWire(name: string, wire: Uint8Array): void {
		const wirePath = path.join(directory, `${name}.malw`);
		writeFileSync(wirePath, wire);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(
			result.status,
			`signal=${result.signal ?? "none"} stderr=${result.stderr}`,
		).toBe(0);
	}

	function uniquePayloadOffset(wire: Uint8Array, payload: Uint8Array): number {
		const bytes = Buffer.from(wire);
		const offset = bytes.indexOf(payload);
		expect(offset).toBeGreaterThanOrEqual(0);
		expect(bytes.indexOf(payload, offset + payload.length)).toBe(-1);
		return offset;
	}
	it("interns empty wire strings before installing language intrinsics", () => {
		acceptsWire(
			"empty-string-constant",
			serializeRuntimeImage(
				{ ...definition, stringConstants: [[]] },
				{ debugInfo: false },
			),
		);
	});
	it("reads empty wire strings through JSON, padding and Symbol descriptions", () => {
		const entrypoint = path.join(directory, "empty-string-operations.mjs");
		writeFileSync(
			entrypoint,
			`function inspect(value) {
				return JSON.stringify({[value]: [value, value.padStart(2, "x"), value.padEnd(2, "x"), String(Symbol(value))]});
			}
			globalThis.inspect = inspect;
			if (inspect("") !== '{"":["","xx","xx","Symbol()"]}') throw new Error("empty string operations");`,
		);
		const image = compileEntrypoint(entrypoint, { stripTypes: stripCompactTypes });
		acceptsWire(
			"empty-string-operations",
			serializeRuntimeImage(image.runtime, { debugInfo: false }),
		);
	});
	it("validates base constructor result registers", () => {
		const resultFn: BytecodeFunction = {
			...fn,
			registerCount: 3,
			literalShapeCount: 0,
			instructions: [
				{ opcode: "CREATE_OBJECT", dst: 0 },
				{ opcode: "CREATE_UNDEFINED", dst: 1 },
				{ opcode: "BASE_CONSTRUCT_RESULT", dst: 2, receiver: 0, value: 1 },
				{ opcode: "RETURN", value: 2 },
			],
		};
		acceptsWire(
			"base-construct-result",
			serializeRuntimeImage(
				{ ...definition, functions: [resultFn] },
				{ debugInfo: false },
			),
		);
		rejectsWire(
			"base-construct-result-register",
			serializeRuntimeImage(
				{
					...definition,
					functions: [
						{
							...resultFn,
							instructions: resultFn.instructions.map((instruction) =>
								instruction.opcode === "BASE_CONSTRUCT_RESULT"
									? { ...instruction, dst: 3 }
									: instruction,
							),
						},
					],
				},
				{ debugInfo: false },
			),
		);
	});
	it("validates precise sum register bounds and bounded side data", () => {
		const image: RuntimeImage = {
			...definition,
			functionCount: 2,
			functions: [
				{
					...fn,
					literalShapeCount: 0,
					instructions: [
						{ opcode: "CREATE_UNDEFINED", dst: 0 },
						{ opcode: "RETURN", value: 0 },
					],
				},
				{
					...fn,
					literalShapeCount: 0,
					instructions: [{ opcode: "PRECISE_NUMBER_SUM", dst: 0, arguments: [0, 0, 0] }],
				},
			],
		};
		const wire = serializeRuntimeImage(image, { debugInfo: false });
		acceptsWire("precise-sum", wire);
		const payload = Buffer.from([
			WIRE_OPCODES.indexOf("PRECISE_NUMBER_SUM"),
			0,
			6,
			3,
			0,
			0,
			0,
		]);
		const offset = Buffer.from(wire).indexOf(payload);
		expect(offset).toBeGreaterThanOrEqual(0);
		expect(Buffer.from(wire).indexOf(payload, offset + payload.length)).toBe(-1);
		for (const [name, operand, value] of [
			["negative-destination", 1, 1],
			["large-destination", 1, 2],
			["negative-count", 2, 1],
			["count-mismatch", 2, 8],
			["length-mismatch", 3, 4],
			["negative-input", 4, 1],
			["large-input", 6, 2],
		] as const) {
			const malformed = wire.slice();
			malformed[offset + operand] = value;
			rejectsWire(`precise-sum-${name}`, malformed);
		}
		image.functions[1]!.instructions = [
			{ opcode: "PRECISE_NUMBER_SUM", dst: 0, arguments: Array<number>(64).fill(0) },
		];
		const maximum = serializeRuntimeImage(image, { debugInfo: false });
		acceptsWire("precise-sum-maximum", maximum);
		const maximumOffset = Buffer.from(maximum).indexOf(
			Buffer.from([
				WIRE_OPCODES.indexOf("PRECISE_NUMBER_SUM"),
				0,
				128,
				1,
				64,
				...Array<number>(64).fill(0),
			]),
		);
		expect(maximumOffset).toBeGreaterThanOrEqual(0);
		maximum[maximumOffset + 2] = 130;
		rejectsWire("precise-sum-excess-count", maximum);
	});
	it("validates prepared collation operands, locale data and option bits", () => {
		const image: RuntimeImage = {
			...definition,
			functionCount: 2,
			stringConstants: [[101, 110], [233], Array<number>(129).fill(97)],
			functions: [
				{
					...fn,
					literalShapeCount: 0,
					instructions: [
						{ opcode: "CREATE_UNDEFINED", dst: 0 },
						{ opcode: "RETURN", value: 0 },
					],
				},
				{
					...fn,
					literalShapeCount: 0,
					instructions: [
						{
							opcode: "PREPARED_STRING_COMPARE",
							dst: 0,
							left: 0,
							right: 0,
							stringIndex: 0,
							options: 2,
						},
					],
				},
			],
		};
		const wire = serializeRuntimeImage(image, { debugInfo: false });
		acceptsWire("prepared-collation", wire);
		const payload = Buffer.from([
			WIRE_OPCODES.indexOf("PREPARED_STRING_COMPARE"),
			0,
			0,
			0,
			0,
			2,
		]);
		const offset = Buffer.from(wire).indexOf(payload);
		expect(offset).toBeGreaterThanOrEqual(0);
		expect(Buffer.from(wire).indexOf(payload, offset + payload.length)).toBe(-1);
		for (const [name, operand, value] of [
			["negative-destination", 1, 1],
			["large-destination", 1, 2],
			["negative-left", 2, 1],
			["large-left", 2, 2],
			["negative-right", 3, 1],
			["large-right", 3, 2],
			["non-ascii-locale", 4, 1],
			["long-locale", 4, 2],
			["missing-locale", 4, 3],
			["invalid-strength", 5, 3],
			["invalid-case", 5, 5],
			["invalid-case-first", 5, 48],
			["invalid-options", 5, 255],
		] as const) {
			const malformed = wire.slice();
			malformed[offset + operand] = value;
			rejectsWire(`collation-${name}`, malformed);
		}
	});
	it("validates builtin error identities and destination registers before execution", () => {
		const errorImage: RuntimeImage = {
			...definition,
			functionCount: 2,
			functions: [
				{
					...fn,
					literalShapeCount: 0,
					instructions: [
						{ opcode: "CREATE_UNDEFINED", dst: 0 },
						{ opcode: "RETURN", value: 0 },
					],
				},
				{
					...fn,
					literalShapeCount: 0,
					instructions: [{ opcode: "BUILTIN_ERROR", dst: 0, error: "uri" }],
				},
			],
		};
		const wire = serializeRuntimeImage(errorImage, { debugInfo: false });
		acceptsWire("builtin-error", wire);
		const payload = Buffer.from([
			WIRE_OPCODES.indexOf("BUILTIN_ERROR"),
			0,
			knownBuiltinErrorNames.indexOf("uri"),
		]);
		const offset = Buffer.from(wire).indexOf(payload);
		expect(offset).toBeGreaterThanOrEqual(0);
		expect(Buffer.from(wire).indexOf(payload, offset + payload.length)).toBe(-1);
		for (const [name, operand, value] of [
			["error-id", 2, 255],
			["negative-error-destination", 1, 1],
			["large-error-destination", 1, 2],
		] as const) {
			const malformed = wire.slice();
			malformed[offset + operand] = value;
			rejectsWire(name, malformed);
		}
	});

	it("validates static-query kinds, registers and primitive payloads", () => {
		const queryDefinition: RuntimeImage = {
			...definition,
			stringConstants: [[120]],
			literalTemplateData: [8, 1, 5, 0],
			functions: [
				{
					...fn,
					registerCount: 3,
					literalShapeCount: 0,
					instructions: [
						{
							opcode: "QUERY_STATIC_DATA",
							dst: 0,
							needle: 1,
							fromIndex: 2,
							templateOffset: 0,
							queryKind: "includes",
						},
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wire = serializeRuntimeImage(queryDefinition, { debugInfo: false });
		acceptsWire("static-query", wire);
		for (const queryKind of ["index-of", "last-index-of"] as const) {
			acceptsWire(
				`static-query-${queryKind}`,
				serializeRuntimeImage({
					...queryDefinition,
					literalTemplateData: [8, 2, 7, 11],
					functions: queryDefinition.functions.map((fn) => ({
						...fn,
						instructions: fn.instructions.map((instruction) =>
							instruction.opcode === "QUERY_STATIC_DATA"
								? { ...instruction, queryKind }
								: instruction,
						),
					})),
				}),
			);
		}
		const encoded = [WIRE_OPCODES.indexOf("QUERY_STATIC_DATA"), 0, 2, 4, 0, 0];
		const offset = wire.findIndex((_, index) =>
			encoded.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(offset).toBeGreaterThan(0);
		for (const [name, operand, byte] of [
			["kind", 5, 8],
			["register", 2, 6],
			["offset", 4, 126],
		] as const) {
			const broken = wire.slice();
			broken[offset + operand] = byte;
			rejectsWire(`static-query-${name}`, broken);
		}
		const payload = [8, 0, 0, 0, 1, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0];
		const payloadOffset = wire.findIndex((_, index) =>
			payload.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(payloadOffset).toBeGreaterThan(0);
		const nested = wire.slice();
		nested[payloadOffset + 8] = 9;
		rejectsWire("static-query-nested-object", nested);
	});

	it("rejects an explicit count that disagrees with its arrays", () => {
		const wire = serializeRuntimeImage(definition, { debugInfo: false });
		const encodedInstruction = Buffer.from([
			WIRE_OPCODES.indexOf("CREATE_OBJECT_SHAPED"),
			0,
			2,
			1,
			0,
			1,
			0,
		]);
		const instructionOffset = uniquePayloadOffset(wire, encodedInstruction);
		wire[instructionOffset + 2] = 4;
		rejectsWire("explicit-count", wire);
	});

	it("rejects mismatched paired-array lengths", () => {
		const wire = serializeRuntimeImage(definition, { debugInfo: false });
		const encodedInstruction = Buffer.from([
			WIRE_OPCODES.indexOf("CREATE_OBJECT_SHAPED"),
			0,
			2,
			1,
			0,
			1,
			0,
		]);
		const instructionOffset = uniquePayloadOffset(wire, encodedInstruction);
		wire[instructionOffset + 5] = 2;
		rejectsWire("paired-count", wire);
	});

	it("rejects guarded target metadata on CONSTRUCT", () => {
		const constructDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					literalShapeCount: 0,
					instructions: [
						{
							opcode: "CONSTRUCT",
							dst: 0,
							callee: 0,
							argumentCount: 0,
							arguments: [],
						},
					],
				},
			],
		};
		const wire = serializeRuntimeImage(constructDefinition, { debugInfo: false });
		const tag = WIRE_OPCODES.indexOf("CONSTRUCT");
		const encodedInstruction = [tag, 0, 0, 1, 0, 0, 0];
		const instructionOffset = wire.findIndex((_, index) =>
			encodedInstruction.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(instructionOffset).toBeGreaterThanOrEqual(0);

		const candidateCountOffset = instructionOffset + 4;
		const forged = new Uint8Array(wire.length + 1);
		forged.set(wire.subarray(0, candidateCountOffset));
		forged.set([1, 0], candidateCountOffset);
		forged.set(wire.subarray(candidateCountOffset + 1), candidateCountOffset + 2);
		rejectsWire("construct-guarded-target", forged);
	});

	it("accepts compact final root maps and rejects malformed portable maps", () => {
		const compactTail: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					literalShapeCount: 0,
					registerCount: 7,
					instructions: [{ opcode: "RETURN", value: 0 }],
					gcSafepoints: [
						{
							instructionIp: 0,
							rootRegisters: [0, 1, 2, 3, 4, 5, 6],
							clearRegisters: [6],
						},
					],
				},
			],
		};
		acceptsWire(
			"safepoint-root-map-compact-tail",
			serializeRuntimeImage(compactTail, { debugInfo: false }),
		);

		const mappedDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					literalShapeCount: 0,
					instructions: [{ opcode: "RETURN", value: 0 }],
					gcSafepoints: [{ instructionIp: 0, rootRegisters: [0] }],
				},
			],
		};
		const wire = serializeRuntimeImage(mappedDefinition, { debugInfo: false });
		const returnTag = WIRE_OPCODES.indexOf("RETURN");
		const encoded = [returnTag, 0, 1, 0, 1, 0, 0];
		const offset = wire.findIndex((_, index) =>
			encoded.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(offset).toBeGreaterThanOrEqual(0);
		acceptsWire("safepoint-root-map", wire);

		const forged = wire.slice();
		forged[offset + 5] = 2;
		rejectsWire("safepoint-root-map-register", forged);
	});

	it("validates portable exact Array length keys and registers", () => {
		const lengthDefinition: RuntimeImage = {
			...definition,
			stringConstants: [
				Array.from("length", (unit) => unit.charCodeAt(0)),
				Array.from("other", (unit) => unit.charCodeAt(0)),
			],
			functions: [
				{
					...fn,
					literalShapeCount: 0,
					registerCount: 2,
					instructions: [
						{ opcode: "CREATE_ARRAY", dst: 1, length: 3 },
						{
							opcode: "LOAD_PROPERTY_STATIC_ARRAY_LENGTH",
							dst: 0,
							object: 1,
							stringIndex: 0,
							icIndex: 0,
						},
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wire = serializeRuntimeImage(lengthDefinition, { debugInfo: false });
		const tag = WIRE_OPCODES.indexOf("LOAD_PROPERTY_STATIC_ARRAY_LENGTH");
		const encodedInstruction = [tag, 0, 2, 0];
		const instructionOffset = wire.findIndex((_, index) =>
			encodedInstruction.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(instructionOffset).toBeGreaterThanOrEqual(0);
		acceptsWire("exact-array-length", wire);

		const wrongKey = wire.slice();
		wrongKey[instructionOffset + 3] = 2;
		rejectsWire("exact-array-length-key", wrongKey);
		const wrongObject = wire.slice();
		wrongObject[instructionOffset + 2] = 4;
		rejectsWire("exact-array-length-object", wrongObject);
	});

	it("rejects known-own-slot side data that disagrees with the source shape", () => {
		const knownSlotFunction: BytecodeFunction = {
			...fn,
			literalShapeCount: 2,
			registerCount: 2,
			instructions: [
				{ opcode: "CREATE_UNDEFINED", dst: 0 },
				{
					opcode: "CREATE_OBJECT_SHAPED",
					dst: 1,
					count: 1,
					keyStringIndices: [0],
					valueRegisters: [0],
					shapeCacheIndex: 0,
				},
				{
					opcode: "CREATE_OBJECT_SHAPED",
					dst: 1,
					count: 1,
					keyStringIndices: [0],
					valueRegisters: [0],
					shapeCacheIndex: 1,
				},
				{
					opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
					dst: 0,
					object: 1,
					stringIndex: 0,
					icIndex: 0,
					candidates: [
						{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 0 },
						{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 },
					],
				},
				{
					opcode: "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
					object: 1,
					value: 0,
					stringIndex: 0,
					icIndex: 1,
					candidates: [
						{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 0 },
						{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 },
					],
				},
				{ opcode: "RETURN", value: 0 },
			],
		};
		const knownSlotDefinition: RuntimeImage = {
			...definition,
			functions: [knownSlotFunction],
			stringConstants: [["x".charCodeAt(0)]],
			precompiledLiteralShapes: [
				{ functionIndex: 0, shapeCacheIndex: 0, keyStringIndices: [0] },
				{ functionIndex: 0, shapeCacheIndex: 1, keyStringIndices: [0] },
			],
		};
		const wire = serializeRuntimeImage(knownSlotDefinition, { debugInfo: false });
		const tag = WIRE_OPCODES.indexOf("LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT");
		const encodedInstruction = [tag, 0, 2, 0, 2, 0, 0, 0, 0, 2, 0];
		const offset = wire.findIndex((_, index) =>
			encodedInstruction.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(offset).toBeGreaterThanOrEqual(0);
		// Change slot ZigZag(0) to ZigZag(1), outside the one-slot source shape.
		wire[offset + encodedInstruction.length - 1] = 2;
		rejectsWire("known-own-slot", wire);

		const duplicate = serializeRuntimeImage(knownSlotDefinition, { debugInfo: false });
		// Rebase the second candidate's shape-cache row 1 to row 0.
		duplicate[offset + encodedInstruction.length - 2] = 0;
		rejectsWire("known-own-slot-duplicate", duplicate);

		const storeWire = serializeRuntimeImage(knownSlotDefinition, { debugInfo: false });
		const storeTag = WIRE_OPCODES.indexOf("STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT");
		const encodedStore = [storeTag, 2, 0, 0, 2, 0, 0, 0, 0, 2, 0];
		const storeOffset = storeWire.findIndex((_, index) =>
			encodedStore.every((byte, operand) => storeWire[index + operand] === byte),
		);
		expect(storeOffset).toBeGreaterThanOrEqual(0);
		storeWire[storeOffset + encodedStore.length - 1] = 2;
		rejectsWire("known-own-slot-store", storeWire);
	});

	it("rejects malformed shared shape-case selectors and slot tables", () => {
		const shapeCaseFunction: BytecodeFunction = {
			...fn,
			literalShapeCount: 1,
			registerCount: 6,
			instructions: [
				{ opcode: "CREATE_UNDEFINED", dst: 0 },
				{
					opcode: "CREATE_OBJECT_SHAPED",
					dst: 2,
					count: 2,
					keyStringIndices: [0, 1],
					valueRegisters: [0, 0],
					shapeCacheIndex: 0,
				},
				{
					opcode: "SELECT_SHAPE_CASE",
					dst: 3,
					object: 2,
					candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 0 }],
				},
				{
					opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE",
					dst: 4,
					object: 2,
					shapeCase: 3,
					stringIndex: 0,
					icIndex: 0,
					slots: [0],
				},
				{
					opcode: "LOAD_PROPERTY_STATIC_SHAPE_CASE",
					dst: 5,
					object: 2,
					shapeCase: 3,
					stringIndex: 1,
					icIndex: 1,
					slots: [1],
				},
				{ opcode: "RETURN", value: 5 },
			],
		};
		const shapeCaseDefinition: RuntimeImage = {
			...definition,
			functions: [shapeCaseFunction],
			stringConstants: [[120], [121]],
			precompiledLiteralShapes: [
				{ functionIndex: 0, shapeCacheIndex: 0, keyStringIndices: [0, 1] },
			],
		};
		const wire = serializeRuntimeImage(shapeCaseDefinition, { debugInfo: false });
		// Two loads are the minimum profitable shared case and must be accepted by
		// the native loader, not merely by the TypeScript serializer.
		acceptsWire("shape-case-two-loads", wire);
		const selectorTag = WIRE_OPCODES.indexOf("SELECT_SHAPE_CASE");
		const encodedSelector = [selectorTag, 6, 4, 1, 0, 0];
		const selectorOffset = wire.findIndex((_, index) =>
			encodedSelector.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(selectorOffset).toBeGreaterThanOrEqual(0);
		const invalidSelector = wire.slice();
		// The only function owns one literal-shape row; row 1 is out of bounds.
		invalidSelector[selectorOffset + encodedSelector.length - 1] = 2;
		rejectsWire("shape-case-selector", invalidSelector);

		const loadTag = WIRE_OPCODES.indexOf("LOAD_PROPERTY_STATIC_SHAPE_CASE");
		const encodedLoad = [loadTag, 10, 4, 6, 2, 1, 2];
		const loadOffset = wire.findIndex((_, index) =>
			encodedLoad.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(loadOffset).toBeGreaterThanOrEqual(0);
		const invalidSlot = wire.slice();
		// Key y must use slot 1; changing it to slot 0 would read x.
		invalidSlot[loadOffset + encodedLoad.length - 1] = 0;
		rejectsWire("shape-case-slot", invalidSlot);

		const encodedFirstLoad = [loadTag, 8, 4, 6, 0, 1, 0];
		const firstLoadOffset = wire.findIndex((_, index) =>
			encodedFirstLoad.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(firstLoadOffset).toBeGreaterThanOrEqual(0);
		const receiverClobber = wire.slice();
		// The first load may not overwrite r2 while later loads still use the
		// selector result for that receiver.
		receiverClobber[firstLoadOffset + 1] = 4;
		rejectsWire("shape-case-receiver", receiverClobber);
	});

	it("pre-instantiates known literal shapes for initial and spliced runtime images", () => {
		const shapedFunction: BytecodeFunction = {
			...fn,
			// Row 2 has no CREATE_OBJECT_SHAPED instruction: it is a portable
			// precompiled descriptor reserved for cross-function shape provenance.
			literalShapeCount: 3,
			registerCount: 3,
			instructions: [
				{ opcode: "CREATE_UNDEFINED", dst: 0 },
				{
					opcode: "CREATE_OBJECT_SHAPED",
					dst: 1,
					count: 1,
					keyStringIndices: [0],
					valueRegisters: [0],
					shapeCacheIndex: 0,
				},
				{
					opcode: "CREATE_OBJECT_SHAPED",
					dst: 2,
					count: 1,
					keyStringIndices: [0],
					valueRegisters: [0],
					shapeCacheIndex: 1,
				},
				{
					opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
					dst: 0,
					object: 1,
					stringIndex: 0,
					icIndex: 0,
					candidates: [{ shapeFunctionIndex: 0, shapeCacheIndex: 2, slot: 0 }],
				},
				{ opcode: "RETURN", value: 0 },
			],
		};
		const shapedDefinition: RuntimeImage = {
			...definition,
			functions: [shapedFunction],
			stringConstants: [["x".charCodeAt(0)]],
			precompiledLiteralShapes: [
				{ functionIndex: 0, shapeCacheIndex: 2, keyStringIndices: [0] },
			],
		};
		const baseDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					instructions: [
						{ opcode: "CREATE_UNDEFINED", dst: 0 },
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
			stringConstants: [[..."padding"].map((unit) => unit.charCodeAt(0))],
		};
		const shapedPath = path.join(directory, "known-shape.malw");
		const basePath = path.join(directory, "known-shape-base.malw");
		writeFileSync(
			shapedPath,
			serializeRuntimeImage(shapedDefinition, { debugInfo: false }),
		);
		writeFileSync(basePath, serializeRuntimeImage(baseDefinition, { debugInfo: false }));
		const environment = {
			...process.env,
			MAL_EXPECT_PRECOMPILED_SHAPES: "1",
			MAL_GC_AT_EXIT: "1",
		};
		const initial = spawnSync(driver, [shapedPath], {
			encoding: "utf8",
			env: environment,
		});
		expect(initial.status, initial.stderr || initial.stdout).toBe(0);
		const spliced = spawnSync(driver, ["--splice", basePath, shapedPath], {
			encoding: "utf8",
			env: environment,
		});
		expect(spliced.status, spliced.stderr || spliced.stdout).toBe(0);
	});

	it("rejects snapshot metadata that disagrees with the opcode prefix", () => {
		// The first function starts at byte 15 after the source-entry field; its
		// snapshot count is eight bytes later.
		rejectsMutation("snapshot-prefix", afterSourceEntry(23), 1);
	});

	it("rejects a snapshot plan that clobbers an aliased source", () => {
		const cycleDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					argumentSnapshotCount: 2,
					argumentSnapshotPlan: [
						{ destination: -1, source: 1 },
						{ destination: 1, source: 0 },
						{ destination: 0, source: -2 },
					],
					registerCount: 2,
					instructions: [
						{ opcode: "LOAD_ARGUMENT", dst: 0, index: 1 },
						{ opcode: "LOAD_ARGUMENT", dst: 1, index: 0 },
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wire = serializeRuntimeImage(cycleDefinition, { debugInfo: false });
		// Move the scratch restore before r1's read of raw argument slot 0.
		wire.set([0, 3, 2, 0], afterSourceEntry(26));
		rejectsWire("snapshot-clobber", wire);
	});

	it("loads and executes an exact direct builtin call", () => {
		const directDefinition: RuntimeImage = {
			...definition,
			stringConstants: [
				[..."alpha,beta"].map((unit) => unit.charCodeAt(0)),
				[",".charCodeAt(0)],
			],
			functions: [
				{
					...fn,
					registerCount: 1,
					instructions: [
						{
							opcode: "CALL_KNOWN",
							dst: 0,
							thisValue: encodeVmValueOperand(-1, { kind: "undefined" }),
							argumentCount: 2,
							arguments: [
								encodeVmValueOperand(-1, { kind: "null" }),
								encodeVmValueOperand(-1, { kind: "boolean", value: true }),
							],
							operation: "Object.is",
						},
						{
							opcode: "CALL_KNOWN",
							dst: 0,
							thisValue: encodeVmValueOperand(-1, { kind: "null" }),
							argumentCount: 2,
							arguments: [
								encodeVmValueOperand(-1, { kind: "boolean", value: false }),
								encodeVmValueOperand(-1, { kind: "number", value: 7 }),
							],
							operation: "Object.is",
						},
						{
							opcode: "CALL_KNOWN",
							dst: 0,
							thisValue: encodeVmValueOperand(-1, { kind: "string", index: 0 }),
							argumentCount: 1,
							arguments: [encodeVmValueOperand(-1, { kind: "string", index: 1 })],
							operation: "String.prototype.split",
						},
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wire = serializeRuntimeImage(directDefinition, { debugInfo: false });
		const wirePath = path.join(directory, "direct-builtin.malw");
		writeFileSync(wirePath, wire);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);

		const builtinTag = WIRE_OPCODES.indexOf("CALL_KNOWN");
		const undefinedReceiverPrefix = [builtinTag, 0, 1, 4, 2, 3, 7];
		const undefinedReceiverOffset = wire.findIndex((_, index) =>
			undefinedReceiverPrefix.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(undefinedReceiverOffset).toBeGreaterThanOrEqual(0);
		const invalidRegister = wire.slice();
		invalidRegister[undefinedReceiverOffset + 2] = 2;
		rejectsWire("direct-builtin-invalid-register", invalidRegister);
		let flagsOffset = undefinedReceiverOffset + undefinedReceiverPrefix.length;
		while ((wire[flagsOffset]! & 128) !== 0) flagsOffset++;
		flagsOffset++;
		for (const flags of [10, 255]) {
			const invalidMode = wire.slice();
			invalidMode[flagsOffset] = flags;
			rejectsWire(`known-operation-invalid-mode-${flags}`, invalidMode);
		}
		const invalidSpecialization = wire.slice();
		invalidSpecialization[flagsOffset + 1] = 255;
		rejectsWire("known-operation-invalid-specialization", invalidSpecialization);

		const splitPrefix = [builtinTag, 0, 9, 2, 1, 11];
		const splitOffset = wire.findIndex((_, index) =>
			splitPrefix.every((byte, operand) => wire[index + operand] === byte),
		);
		expect(splitOffset).toBeGreaterThanOrEqual(0);
		const invalidString = wire.slice();
		invalidString[splitOffset + 2] = 13;
		rejectsWire("direct-builtin-invalid-string", invalidString);
	});

	it("loads guarded Math, collection, formatting and predicate tags and rejects malformed hints", () => {
		const entrypoint = path.join(directory, "guarded-call-tags.mjs");
		writeFileSync(
			entrypoint,
			`function guardedOperations(map, array, value) {
				array.push(value);
				globalThis.last = array.at(-1);
				globalThis.formatted = [value.toFixed(), value.toExponential(2), value.toPrecision(2, 0, 0, 0, 0)];
				globalThis.predicates = [Number.isNaN(value), Number.isFinite(value, 0, 0, 0, 0), Number.isInteger(), Number.isSafeInteger(value)];
				return Math.round(value) + Math.max(value, 3) + map.get("answer");
			}
			globalThis.guardedOperations = guardedOperations;
			const array = [];
			globalThis.result = guardedOperations(new Map([["answer", 4]]), array, 2.4);
			if (globalThis.result !== 9 || array.length !== 1 || array[0] !== 2.4) {
				throw new Error("guarded call tag execution mismatch");
			}\n`,
		);
		const guardedDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
			buildConfig: resolveBuildConfig({ engine: { primordials: "mutable" } }),
		});
		type GuardedCall = Extract<BytecodeInstruction, { opcode: "CALL" }>;
		type GuardedSite = {
			functionIndex: number;
			instructionIndex: number;
			instruction: GuardedCall;
		};
		const guardedSites: Array<GuardedSite> = [];
		for (const [functionIndex, fn] of guardedDefinition.runtime.functions.entries()) {
			for (const [instructionIndex, instruction] of fn.instructions.entries()) {
				if (
					instruction.opcode === "CALL" &&
					(instruction.guardedMathCall !== undefined ||
						instruction.guardedBuiltinCall !== undefined)
				) {
					guardedSites.push({ functionIndex, instructionIndex, instruction });
				}
			}
		}
		const unary = guardedSites.find(
			(site) => site.instruction.guardedMathCall?.kind === "unary",
		);
		const binary = guardedSites.find(
			(site) => site.instruction.guardedMathCall?.kind === "binary",
		);
		const collection = guardedSites.find(
			(site) => site.instruction.guardedBuiltinCall?.operation === "Map.prototype.get",
		);
		const arrayPush = guardedSites.find(
			(site) => site.instruction.guardedBuiltinCall?.operation === "Array.prototype.push",
		);
		const arrayAt = guardedSites.find(
			(site) => site.instruction.guardedBuiltinCall?.operation === "Array.prototype.at",
		);
		expect(unary).toBeDefined();
		expect(binary).toBeDefined();
		expect(collection).toBeDefined();
		expect(arrayPush).toBeDefined();
		expect(arrayAt).toBeDefined();
		for (const method of ["toFixed", "toExponential", "toPrecision"])
			expect(
				guardedSites.some(
					(site) =>
						site.instruction.guardedBuiltinCall?.operation ===
						`Number.prototype.${method}`,
				),
			).toBe(true);
		for (const method of ["isNaN", "isFinite", "isInteger", "isSafeInteger"])
			expect(
				guardedSites.some(
					(site) => site.instruction.guardedBuiltinCall?.operation === `Number.${method}`,
				),
			).toBe(true);
		if (
			unary === undefined ||
			binary === undefined ||
			collection === undefined ||
			arrayPush === undefined ||
			arrayAt === undefined
		) {
			throw new Error("expected guarded call sites");
		}

		const wire = serializeRuntimeImage(guardedDefinition.runtime, { debugInfo: false });
		const guardedTagOffset = (site: GuardedSite): number => {
			const functions = guardedDefinition.runtime.functions.map((fn, functionIndex) => {
				if (functionIndex !== site.functionIndex) return fn;
				return {
					...fn,
					instructions: fn.instructions.map((instruction, instructionIndex) => {
						if (instructionIndex !== site.instructionIndex) return instruction;
						if (instruction.opcode !== "CALL") throw new Error("expected CALL");
						const unguarded: GuardedCall = { ...instruction };
						delete unguarded.guardedMathCall;
						delete unguarded.guardedBuiltinCall;
						return unguarded;
					}),
				};
			});
			const unguardedWire = serializeRuntimeImage(
				{ ...guardedDefinition.runtime, functions },
				{ debugInfo: false },
			);
			const differences: Array<number> = [];
			for (let index = 0; index < wire.length; index++) {
				if (wire[index] !== unguardedWire[index]) differences.push(index);
			}
			expect(differences).toHaveLength(1);
			const offset = differences[0]!;
			expect(unguardedWire[offset]).toBe(0);
			return offset;
		};
		const unaryTagOffset = guardedTagOffset(unary);
		const binaryTagOffset = guardedTagOffset(binary);
		const collectionTagOffset = guardedTagOffset(collection);
		const arrayPushTagOffset = guardedTagOffset(arrayPush);
		expect(wire[unaryTagOffset]).toBeGreaterThan(0);
		expect(wire[binaryTagOffset]).toBeGreaterThan(0);
		expect(wire[collectionTagOffset]).toBeGreaterThan(wire[binaryTagOffset]!);
		expect(wire[arrayPushTagOffset]).toBeGreaterThan(wire[collectionTagOffset]!);
		acceptsWire("guarded-call-tags", wire);

		const invalidTag = wire.slice();
		invalidTag[collectionTagOffset] = 0xff;
		rejectsWire("guarded-call-invalid-tag", invalidTag);

		const invalidArity = wire.slice();
		invalidArity[unaryTagOffset] = wire[binaryTagOffset]!;
		rejectsWire("guarded-call-invalid-arity", invalidArity);

		const genericFiveArgumentCall: Extract<BytecodeInstruction, { opcode: "CALL" }> = {
			opcode: "CALL",
			dst: 0,
			callee: 0,
			thisValue: 0,
			argumentCount: 5,
			arguments: [0, 0, 0, 0, 0],
		};
		const fiveArgumentDefinition = (guarded: boolean): RuntimeImage => ({
			...definition,
			functions: [
				{
					...fn,
					literalShapeCount: 0,
					instructions: [
						guarded
							? ({
									...genericFiveArgumentCall,
									guardedBuiltinCall: { operation: "Map.prototype.get" },
								} satisfies BytecodeInstruction)
							: genericFiveArgumentCall,
					],
				},
			],
		});
		const genericFiveArgumentWire = serializeRuntimeImage(fiveArgumentDefinition(false), {
			debugInfo: false,
		});
		const guardedFiveArgumentWire = serializeRuntimeImage(fiveArgumentDefinition(true), {
			debugInfo: false,
		});
		const fiveArgumentDifferences: Array<number> = [];
		for (let index = 0; index < genericFiveArgumentWire.length; index++) {
			if (genericFiveArgumentWire[index] !== guardedFiveArgumentWire[index]) {
				fiveArgumentDifferences.push(index);
			}
		}
		expect(fiveArgumentDifferences).toHaveLength(1);
		const invalidArrayPushArity = genericFiveArgumentWire.slice();
		invalidArrayPushArity[fiveArgumentDifferences[0]!] =
			VM_MATH_UNARY_NUMBER_OPERATIONS.length +
			VM_MATH_BINARY_NUMBER_OPERATIONS.length +
			VM_GUARDED_BUILTIN_CALL_OPERATIONS.indexOf("Array.prototype.push") +
			1;
		rejectsWire("guarded-array-push-invalid-arity", invalidArrayPushArity);
	});

	it("rejects malformed varints and trailing data", () => {
		const wire = serializeRuntimeImage(definition, { debugInfo: false });
		const replaceFlags = (bytes: Array<number>): Uint8Array =>
			Uint8Array.from([...wire.subarray(0, 8), ...bytes, ...wire.subarray(9)]);

		rejectsWire("overlong-varint", replaceFlags([0x80, 0]));
		rejectsWire("overflowing-varint", replaceFlags([0x80, 0x80, 0x80, 0x80, 0x10]));
		rejectsWire("trailing-data", Uint8Array.from([...wire, 0]));
	});

	it("loads bulk private-name and private-field side data", () => {
		const bulkDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					registerCount: 3,
					capturedCount: 2,
					instructions: [
						{
							opcode: "CREATE_PRIVATE_NAMES",
							ownerFunctionIndex: 0,
							capturedIndices: [0, 1],
						},
						{ opcode: "INIT_PRIVATE_FIELDS", object: 0, keyRegisters: [1, 2] },
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wirePath = path.join(directory, "bulk-private.malw");
		writeFileSync(wirePath, serializeRuntimeImage(bulkDefinition, { debugInfo: false }));
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status).toBe(0);
	});

	it("loads canonical typeof comparison operands", () => {
		const typeofDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					registerCount: 2,
					instructions: [
						{ opcode: "CREATE_UNDEFINED", dst: 1 },
						{
							opcode: "TYPEOF_COMPARE",
							dst: 0,
							src: 1,
							expected: "undefined",
							negated: false,
						},
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wirePath = path.join(directory, "typeof-compare.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(typeofDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status).toBe(0);
	});

	it("loads an appended terminal-yield operand", () => {
		const terminalDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					instructions: [
						{ opcode: "CREATE_UNDEFINED", dst: 0 },
						{ opcode: "RETURN", value: 0 },
						{ opcode: "TERMINAL_YIELD", yieldedSrc: 0 },
					],
				},
			],
		};
		const wirePath = path.join(directory, "terminal-yield.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(terminalDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads a nonempty String.split cursor proof region payload", () => {
		const entrypoint = path.join(directory, "string-split-cursor-region.mjs");
		writeFileSync(
			entrypoint,
			`function run(value, separator) {
				const parts = value.split(separator);
				let total = 0;
				for (let index = 0; index < parts.length; index++) {
					total += parts[index].trim().length;
				}
				return total;
			}
			globalThis.result = run(" alpha, beta ", ",");\n`,
		);
		const cursorDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
		});
		expect(
			cursorDefinition.native.functions.flatMap((fn) =>
				fn.specializations.filter((region) => region.kind === "string-split-cursor"),
			),
		).toHaveLength(1);
		const wirePath = path.join(directory, "string-split-cursor-region.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(cursorDefinition.runtime, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads a nonempty String.split projection proof region payload", () => {
		const entrypoint = path.join(directory, "string-split-projection-region.mjs");
		writeFileSync(
			entrypoint,
			`function project(value) {
				const fields = String(value).split(";");
				return fields[1] + fields[0] + fields.length;
			}
			globalThis.project = project;
			globalThis.result = project("alpha;beta");\n`,
		);
		const projectionDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
			buildConfig: resolveBuildConfig({}),
		});
		const projectionSites = projectionDefinition.native.functions.flatMap((native) =>
			native.specializations
				.filter((region) => region.kind === "string-split-projection")
				.map((region) => ({
					fn: projectionDefinition.runtime.functions[native.functionIndex]!,
					region,
				})),
		);
		expect(projectionSites.length).toBeGreaterThan(0);
		expect(
			projectionSites.some(
				({ fn, region }) => fn.instructions[region.callIp]?.opcode === "CALL_KNOWN",
			),
		).toBe(true);
		const wirePath = path.join(directory, "string-split-projection-region.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(projectionDefinition.runtime, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads a nonempty RegExp.exec projection proof region payload", () => {
		const entrypoint = path.join(directory, "regexp-exec-projection-region.mjs");
		writeFileSync(
			entrypoint,
			`function parse(regexp, value) {
				const match = regexp.exec(value);
				if (match === null) return -1;
				return Number(match[1]);
			}
			globalThis.result = parse(/([0-9]+)/, "42");\n`,
		);
		const projectionDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
			buildConfig: resolveBuildConfig({}),
		});
		expect(
			projectionDefinition.native.functions.flatMap((fn) =>
				fn.specializations.filter((region) => region.kind === "regexp-exec-projection"),
			),
		).not.toHaveLength(0);
		const wirePath = path.join(directory, "regexp-exec-projection-region.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(projectionDefinition.runtime, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads a nonempty RegExp iterator projection proof region payload", () => {
		const entrypoint = path.join(directory, "regexp-iterator-projection-region.mjs");
		writeFileSync(
			entrypoint,
			`function total(value, regexp) {
				let sum = 0;
				for (const match of value.matchAll(regexp)) sum += Number(match[1]);
				return sum;
			}
			globalThis.result = total("1 2 3", /([0-9]+)/g);\n`,
		);
		const projectionDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
			buildConfig: resolveBuildConfig({}),
		});
		expect(
			projectionDefinition.native.functions.flatMap((fn) =>
				fn.specializations.filter(
					(region) => region.kind === "regexp-iterator-projection",
				),
			),
		).not.toHaveLength(0);
		const wirePath = path.join(directory, "regexp-iterator-projection-region.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(projectionDefinition.runtime, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads a nonempty String.slice Number proof region payload", () => {
		const entrypoint = path.join(directory, "string-slice-number-region.mjs");
		writeFileSync(
			entrypoint,
			`function parse(value) {
				try {
					return Number(value.slice(1));
				} catch {
					return -1;
				}
			}
			globalThis.result = parse("x42");\n`,
		);
		const regionDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
			buildConfig: resolveBuildConfig({}),
		});
		expect(
			regionDefinition.native.functions.flatMap((fn) =>
				fn.specializations.filter((region) => region.kind === "string-slice-number"),
			),
		).not.toHaveLength(0);
		const wirePath = path.join(directory, "string-slice-number-region.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(regionDefinition.runtime, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads and executes persisted stack-object plan regions", () => {
		const entrypoint = path.join(directory, "stack-object-plan-region.mjs");
		writeFileSync(
			entrypoint,
			`function read(escape) {
				const value = { x: 41, tag: "stack" };
				if (escape) return value;
				return typeof value === "object" ? value.x + 1 : 0;
			}
			if (read(false) !== 42 || read(true).tag !== "stack") throw new Error("bad stack plan");\n`,
		);
		const stackDefinition = compileEntrypoint(entrypoint, {
			stripTypes: stripCompactTypes,
			buildConfig: resolveBuildConfig({}),
		});
		expect(
			stackDefinition.native.functions.flatMap((fn) =>
				fn.specializations.filter((region) => region.kind === "stack-object-plan"),
			),
		).not.toHaveLength(0);
		const wirePath = path.join(directory, "stack-object-plan-region.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(stackDefinition.runtime, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads and executes persisted argument snapshot prefixes", () => {
		const snapshotDefinition: RuntimeImage = {
			...definition,
			functions: [
				{
					...fn,
					argumentSnapshotCount: 2,
					argumentSnapshotPlan: [
						{ destination: 0, source: -1 },
						{ destination: 1, source: 4 },
					],
					registerCount: 2,
					instructions: [
						{ opcode: "LOAD_ARGUMENT_COUNT", dst: 0 },
						{ opcode: "LOAD_ARGUMENT", dst: 1, index: 4 },
						{ opcode: "RETURN", value: 0 },
					],
				},
			],
		};
		const wirePath = path.join(directory, "argument-snapshots.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(snapshotDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], { encoding: "utf8" });
		expect(result.status, result.stderr || result.stdout).toBe(0);
	});

	it("loads unaligned fixed-width little-endian scalar fields", () => {
		const scalarDefinition: RuntimeImage = {
			...definition,
			// A two-byte global-count varint places the following u16/u64/fixed-u32
			// payloads at deliberately unaligned offsets.
			globalCount: 128,
			stringConstants: [[0xd800, 0xabcd]],
			bigintConstants: [-0x0123456789abcdef0123456789abcdefn],
			literalTemplateData: [0x01234567, 0x89abcdef],
			functions: [
				{
					...fn,
					registerCount: 2,
					instructions: [
						{ opcode: "CREATE_F64", dst: 0, value: 6.25 },
						{ opcode: "CREATE_F64", dst: 1, value: -0 },
						{ opcode: "RETURN", value: 1 },
					],
				},
			],
		};
		const wirePath = path.join(directory, "unaligned-scalars.malw");
		writeFileSync(
			wirePath,
			serializeRuntimeImage(scalarDefinition, { debugInfo: false }),
		);
		const result = spawnSync(driver, [wirePath], {
			encoding: "utf8",
			env: { ...process.env, MAL_DUMP_LOADED_SCALARS: "1" },
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe(
			[
				"string[0] d800 abcd",
				"bigint[0] fedcba9876543210fedcba9876543211",
				"literal[0] 01234567",
				"literal[1] 89abcdef",
				"f64[0:0] 4019000000000000",
				"f64[0:1] 8000000000000000",
				"",
			].join("\n"),
		);
	});
});
