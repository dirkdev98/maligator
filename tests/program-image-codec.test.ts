import { describe, expect, it } from "vitest";
import {
	COMPILER_ARTIFACT_VERSION,
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	MAX_STRING_CODE_UNITS,
	WIRE_OPCODES,
} from "../src/compiler/target/program-image-codec.ts";
import { VM_GUARDED_BUILTIN_OPERATIONS } from "../src/compiler/target/program-image.ts";
import type {
	ProgramImage,
	NativeInstructionPlan,
	VmRegion,
} from "../src/compiler/target/program-image.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import {
	buildArgumentSnapshotPlan,
	encodeVmValueOperand,
	vmSafepointRootMapsAreTrusted,
} from "../src/compiler/target/runtime-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
} from "../src/compiler/target/runtime-image.ts";
import { testProgramImage, withNativeFunctionPlan } from "./helpers/program-image.ts";

// A definition exercising the tricky encodings: variable-length operand arrays
// (CALL / CREATE_OBJECT_SHAPED / CREATE_MODULE_NAMESPACE / CREATE_TEMPLATE_OBJECT /
// COPY_DATA_PROPERTIES / INIT_GLOBAL_VARS / CREATE_PRIVATE_NAMES /
// INIT_PRIVATE_FIELDS), no-fallback numeric Math, the f64 / boolean / enum /
// u16-intrinsic operands,
// strings (incl. astral code units), bigints (incl. > 64 bits), handlers, the
// vestigial TRY_BEGIN (handlerIp dropped → 0), and debug tables.
const instructions: Array<BytecodeInstruction> = [
	{ opcode: "CREATE_NUMBER", dst: 0, value: 42 },
	{ opcode: "CREATE_F64", dst: 1, value: 3.5 },
	{ opcode: "CREATE_BOOLEAN", dst: 2, value: true },
	{ opcode: "CREATE_STRING", dst: 3, stringIndex: 1 },
	{ opcode: "CREATE_BIGINT", dst: 4, bigintIndex: 0 },
	{ opcode: "INSTANTIATE_LITERAL_TEMPLATE", dst: 4, templateOffset: 0 },
	{ opcode: "LOAD_INTRINSIC", dst: 5, intrinsic: "Math" },
	{ opcode: "LOAD_INTRINSIC", dst: 6, intrinsic: "__arrayFlatMapAppend" },
	{ opcode: "MOVE", dst: 7, src: 0 },
	{ opcode: "LOAD_SUPER_PROPERTY", dst: 7, object: 10, key: 3, receiver: 10 },
	{
		opcode: "LOAD_PROPERTY_STATIC",
		dst: 7,
		object: 10,
		stringIndex: 1,
		icIndex: 0,
	},
	{
		opcode: "STORE_PROPERTY_STATIC",
		object: 10,
		value: 7,
		stringIndex: 1,
		icIndex: 1,
	},
	{ opcode: "BINARY", dst: 8, left: 0, right: 1, operator: ">>>" },
	{ opcode: "UNARY", dst: 9, src: 8, operator: "typeof" },
	{ opcode: "MATH_UNARY_NUMBER", dst: 9, src: 1, operation: "Math.floor" },
	{
		opcode: "MATH_BINARY_NUMBER",
		dst: 9,
		left: 0,
		right: 1,
		operation: "Math.max",
	},
	{
		opcode: "CALL_BUILTIN",
		dst: 9,
		thisValue: 0,
		argumentCount: 2,
		arguments: [1, 2],
		operation: "String.prototype.split",
	},
	{
		opcode: "CALL_BUILTIN",
		dst: 9,
		thisValue: 10,
		argumentCount: 3,
		arguments: [0, 1, 2],
		operation: "Array.prototype.push",
	},
	{
		opcode: "CALL_BUILTIN",
		dst: 9,
		thisValue: 10,
		argumentCount: 2,
		arguments: [0, 3],
		operation: "Object.hasOwn",
	},
	{
		opcode: "CALL_BUILTIN",
		dst: 9,
		thisValue: 3,
		argumentCount: 1,
		arguments: [0],
		operation: "String.prototype.charCodeAt",
	},
	{
		opcode: "CALL_BUILTIN",
		dst: 9,
		thisValue: 10,
		argumentCount: 1,
		arguments: [0],
		operation: "Map.prototype.get",
	},
	{
		opcode: "CALL_BUILTIN",
		dst: 9,
		thisValue: 10,
		argumentCount: 2,
		arguments: [0, 1],
		operation: "Map.prototype.set",
	},
	{
		opcode: "CALL_BUILTIN",
		dst: 9,
		thisValue: 10,
		argumentCount: 1,
		arguments: [0],
		operation: "Object.keys",
	},
	{
		opcode: "CALL_BUILTIN",
		dst: 9,
		thisValue: 10,
		argumentCount: 1,
		arguments: [0],
		operation: "Object.values",
	},
	{
		opcode: "TYPEOF_COMPARE",
		dst: 9,
		src: 8,
		expected: "number",
		negated: true,
	},
	{ opcode: "TRY_BEGIN", handlerIp: 0 },
	{
		opcode: "CREATE_OBJECT_SHAPED",
		dst: 10,
		count: 2,
		keyStringIndices: [0, 1],
		valueRegisters: [3, 7],
		shapeCacheIndex: 0,
	},
	{
		opcode: "CALL",
		dst: 11,
		callee: 5,
		thisValue: 10,
		argumentCount: 3,
		arguments: [0, 1, 2],
	},
	{
		opcode: "CREATE_TEMPLATE_OBJECT",
		dst: 12,
		cacheSlot: 2,
		cookedIndices: [0, -1, 1],
		rawIndices: [0, 1, 1],
	},
	{
		opcode: "CREATE_MODULE_NAMESPACE",
		dst: 13,
		nameIndices: [0, 1],
		slots: [4, 5],
	},
	{
		opcode: "COPY_DATA_PROPERTIES",
		dst: 14,
		src: 10,
		excludedCount: 1,
		excluded: [3],
	},
	{
		opcode: "DEFINE_ACCESSOR",
		object: 10,
		key: 3,
		accessor: 5,
		isSetter: false,
		enumerable: true,
	},
	{ opcode: "ITERATOR_CLOSE", iterator: 10, normal: true },
	{ opcode: "SET_PROTOTYPE", object: 10, prototype: 13, literal: true },
	{ opcode: "LOAD_ARGUMENT_COUNT", dst: 14 },
	{ opcode: "LOAD_ARGUMENT", dst: 14, index: 2 },
	{
		opcode: "LOAD_STATIC_ARGUMENT",
		dst: 14,
		direct: -1,
		fallback: 13,
		index: 2,
	},
	{ opcode: "TRY_END" },
	{ opcode: "ENV_PUSH", scopeId: -2, slotCount: 1 },
	{ opcode: "ENV_POP" },
	{
		opcode: "INIT_GLOBAL_VARS",
		nameStringIndices: [0, 1],
		declarationConfigurable: true,
	},
	{
		opcode: "CREATE_PRIVATE_NAMES",
		ownerFunctionIndex: 0,
		capturedIndices: [0, 2],
	},
	{ opcode: "INIT_PRIVATE_FIELDS", object: 10, keyRegisters: [3, 7] },
	{
		opcode: "CALL_SPREAD_ITERABLE",
		dst: 11,
		callee: 5,
		thisValue: 10,
		iterable: 12,
	},
	{
		opcode: "CONSTRUCT_SUPER_EXPLICIT",
		dst: 11,
		parent: 5,
		argumentsArray: 12,
		newTarget: 6,
	},
	{ opcode: "SET_THIS", value: 11 },
	{ opcode: "RETURN", value: 11 },
];

const mainFn: BytecodeFunction = {
	nameStringIndex: 0,
	isGenerator: false,
	isAsync: false,
	parameterCount: 1,
	mappedArguments: false,
	mappedArgumentSlots: [],
	length: 1,
	registerCount: 15,
	capturedCount: 0,
	strict: true,
	needsArguments: true,
	argumentSnapshotCount: 0,
	argumentSnapshotPlan: [],
	isDerivedConstructor: false,
	isClassConstructor: false,
	hasPrototype: true,
	literalShapeCount: 1,
	instructions,
	handlers: [{ startIp: 10, endIp: 19, handlerIp: 20 }],
	fileIndex: 0,
	// Canonical (compress→expand fixed-point) per-instruction positions.
	positions: instructions.map((_, ip) => (ip < 11 ? 0 : ip < 20 ? 1 : 2)),
};

const genFn: BytecodeFunction = {
	nameStringIndex: 2,
	isGenerator: true,
	isAsync: true,
	parameterCount: 0,
	mappedArguments: false,
	mappedArgumentSlots: [],
	length: 0,
	registerCount: 3,
	capturedCount: 1,
	strict: true,
	needsArguments: true,
	argumentSnapshotCount: 0,
	argumentSnapshotPlan: [],
	isDerivedConstructor: true,
	isClassConstructor: true,
	hasPrototype: false,
	literalShapeCount: 0,
	instructions: [
		{ opcode: "ASYNC_START" },
		{ opcode: "AWAIT", awaitedSrc: 0, valueDst: 1, modeDst: 2 },
		{ opcode: "YIELD", yieldedSrc: 1, valueDst: 0, modeDst: 2 },
		{ opcode: "TERMINAL_YIELD", yieldedSrc: 1 },
		{ opcode: "RETURN", value: 0 },
	],
	handlers: [],
	fileIndex: 1,
	positions: [0, 0, 0, 0, 0],
};

const definition: ProgramImage = testProgramImage({
	entrypointPath: "/fixture/entry.mjs",
	functionCount: 2,
	functions: [mainFn, genFn],
	stringConstants: [
		[],
		[0x66, 0x6f, 0x6f], // "foo"
		[0xd83d, 0xde00], // astral pair
	],
	bigintConstants: [42n, -((1n << 100n) + 7n)],
	literalTemplateData: [8, 2, 5, 1, 4, 0, 0x80000000],
	precompiledLiteralShapes: [],
	globalCount: 6,
	files: ["compiled://a.js", "compiled://b.ts"],
	sourcePositions: [
		{ line: 1, column: 0 },
		{ line: 2, column: 4 },
		{ line: 3, column: 8, inlinedFunctionIndex: 1, callerPosId: 0 },
	],
	cjsModuleFunctionIndices: [1],
	hostInstalls: [],
});

const hostDefinition: ProgramImage = withRuntime(definition, {
	hostInstalls: [
		{
			installer: "mal_host_install_node_path",
			exports: [
				{ name: "join", slot: 3 },
				{ name: "default", slot: 4 },
			],
		},
		{
			installer: "mal_host_install_process",
			exports: [{ name: "process", slot: 5 }],
		},
	],
});

function withRuntime(
	image: ProgramImage,
	overrides: Partial<ProgramImage["runtime"]>,
): ProgramImage {
	return { ...image, runtime: { ...image.runtime, ...overrides } };
}

function withBytecodeFunctions(
	image: ProgramImage,
	functions: Array<BytecodeFunction>,
): ProgramImage {
	const sourcePositions = image.runtime.sourcePositions.map((position) =>
		position.inlinedFunctionIndex !== undefined &&
		position.inlinedFunctionIndex >= functions.length
			? {
					line: position.line,
					column: position.column,
					...(position.callerPosId === undefined
						? {}
						: { callerPosId: position.callerPosId }),
				}
			: position,
	);
	return {
		...image,
		runtime: {
			...image.runtime,
			functionCount: functions.length,
			functions,
			sourcePositions,
			cjsModuleFunctionIndices: image.runtime.cjsModuleFunctionIndices.filter(
				(index) => index < functions.length,
			),
		},
		native: createConservativeNativePlan(functions),
	};
}

function stackObjectDefinition(): ProgramImage {
	const stackFixture: BytecodeFunction & {
		registerRepresentations: Array<"boxed">;
		regions: Array<VmRegion>;
	} = {
		...mainFn,
		nameStringIndex: -1,
		parameterCount: 0,
		length: 0,
		registerCount: 4,
		needsArguments: false,
		instructions: [
			{ opcode: "CREATE_NUMBER", dst: 0, value: 41 },
			{ opcode: "CREATE_NUMBER", dst: 1, value: 42 },
			{
				opcode: "CREATE_OBJECT_SHAPED",
				dst: 2,
				count: 2,
				keyStringIndices: [0, 1],
				valueRegisters: [0, 1],
				shapeCacheIndex: 0,
			},
			{
				opcode: "LOAD_PROPERTY_STATIC",
				dst: 3,
				object: 2,
				stringIndex: 1,
				icIndex: 0,
			},
			{
				opcode: "STORE_PROPERTY_STATIC",
				object: 2,
				value: 0,
				stringIndex: 1,
				icIndex: 1,
			},
			{ opcode: "RETURN", value: 3 },
		],
		handlers: [],
		positions: [],
		registerRepresentations: ["boxed", "boxed", "boxed", "boxed"],
		regions: [
			{
				kind: "stack-object-plan",
				license: {
					guard: { dependencies: [], obligations: ["fallback"] },
					genericTwin: "retained",
					materialization: "none",
					admission: { anchorIp: 2, mode: "stable" },
				},
				representation: "activation-local-fixed-shape-objects",
				anchors: [2],
				claimedIps: [2, 3, 4],
				controlFlow: { ordinaryBlockIps: [2, 3, 4], exceptionalHandlerIps: [] },
				cost: { score: 2, metadataOperations: 3 },
				sites: [
					{
						allocationIp: 2,
						slotCount: 2,
						accesses: [
							{ ip: 3, slot: 1 },
							{ ip: 4, slot: 1 },
						],
						materializations: [],
					},
				],
			},
		],
	};
	const { registerRepresentations, regions, ...stackFn } = stackFixture;
	return withNativeFunctionPlan(
		{
			...withRuntime(definition, {
				functionCount: 1,
				functions: [stackFn],
				stringConstants: [["first".charCodeAt(0)], ["second".charCodeAt(0)]],
				bigintConstants: [],
				literalTemplateData: [],
				globalCount: 0,
				files: [],
				sourcePositions: [],
				cjsModuleFunctionIndices: [],
			}),
			native: createConservativeNativePlan([stackFn]),
		},
		0,
		(plan) => ({
			...plan,
			registerRepresentations,
			specializations: regions,
		}),
	);
}

function knownOwnSlotDefinition(): ProgramImage {
	const base = stackObjectDefinition();
	const fn = base.runtime.functions[0]!;
	const instructions: Array<BytecodeInstruction> = [
		{ opcode: "CREATE_NUMBER", dst: 0, value: 41 },
		{ opcode: "CREATE_NUMBER", dst: 1, value: 42 },
		{
			opcode: "CREATE_OBJECT_SHAPED",
			dst: 2,
			count: 2,
			keyStringIndices: [0, 1],
			valueRegisters: [0, 1],
			shapeCacheIndex: 0,
		},
		{
			opcode: "CREATE_OBJECT_SHAPED",
			dst: 2,
			count: 1,
			keyStringIndices: [1],
			valueRegisters: [1],
			shapeCacheIndex: 1,
		},
		{
			opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
			dst: 3,
			object: 2,
			stringIndex: 1,
			icIndex: 0,
			candidates: [
				{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 1 },
				{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 },
			],
		},
		{
			opcode: "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
			object: 2,
			value: 0,
			stringIndex: 1,
			icIndex: 1,
			candidates: [
				{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 1 },
				{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 },
			],
		},
		{ opcode: "RETURN", value: 3 },
	];
	return withBytecodeFunctions(
		withRuntime(base, {
			precompiledLiteralShapes: [
				{ functionIndex: 0, shapeCacheIndex: 0, keyStringIndices: [0, 1] },
				{ functionIndex: 0, shapeCacheIndex: 1, keyStringIndices: [1] },
			],
		}),
		[
			{
				...fn,
				literalShapeCount: 2,
				instructions,
				positions: instructions.map(() => 0),
			},
		],
	);
}

function shapeCaseDefinition(): ProgramImage {
	const base = knownOwnSlotDefinition();
	const fn = base.runtime.functions[0]!;
	const instructions: Array<BytecodeInstruction> = [
		{ opcode: "CREATE_NUMBER", dst: 0, value: 41 },
		{ opcode: "CREATE_NUMBER", dst: 1, value: 42 },
		{
			opcode: "CREATE_OBJECT_SHAPED",
			dst: 2,
			count: 2,
			keyStringIndices: [0, 1],
			valueRegisters: [0, 1],
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
	];
	const functions: Array<BytecodeFunction> = [
		{
			...fn,
			registerCount: 6,
			literalShapeCount: 1,
			instructions,
			positions: instructions.map(() => 0),
		},
	];
	return withNativeFunctionPlan(
		{
			...withRuntime(base, {
				stringConstants: [[120], [121]],
				precompiledLiteralShapes: [
					{ functionIndex: 0, shapeCacheIndex: 0, keyStringIndices: [0, 1] },
				],
				functions,
			}),
			native: createConservativeNativePlan(functions),
		},
		0,
		(plan) => plan,
	);
}

describe("program-image-codec", () => {
	it("round-trips portable root maps as untrusted metadata and rejects malformed maps", () => {
		const mapped = withBytecodeFunctions(definition, [
			{
				...mainFn,
				gcSafepoints: [
					{ instructionIp: 0, rootRegisters: [0, 3] },
					{ instructionIp: 27, rootRegisters: [5, 10, 11] },
				],
			},
		]);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(mapped));
		expect(restored.runtime.functions[0]!.gcSafepoints).toEqual(
			mapped.runtime.functions[0]!.gcSafepoints,
		);
		expect(vmSafepointRootMapsAreTrusted(restored.runtime.functions[0]!)).toBe(false);

		const malformed = withBytecodeFunctions(definition, [
			{
				...mainFn,
				gcSafepoints: [{ instructionIp: 0, rootRegisters: [3, 3] }],
			},
		]);
		expect(() => serializeCompilerArtifact(malformed)).toThrow(
			"invalid VM safepoint root register",
		);
	});

	it("round-trips and validates tagged direct-builtin operands", () => {
		const call: BytecodeInstruction = {
			opcode: "CALL_BUILTIN",
			dst: 0,
			thisValue: encodeVmValueOperand(-1, { kind: "undefined" }),
			argumentCount: 6,
			arguments: [
				1,
				encodeVmValueOperand(-1, { kind: "null" }),
				encodeVmValueOperand(-1, { kind: "boolean", value: false }),
				encodeVmValueOperand(-1, { kind: "boolean", value: true }),
				encodeVmValueOperand(-1, { kind: "number", value: -7 }),
				encodeVmValueOperand(-1, { kind: "string", index: 0 }),
			],
			operation: "Object.is",
		};
		const builtinFunction: BytecodeFunction = {
			...mainFn,
			registerCount: 2,
			instructions: [call],
			positions: [],
		};
		const valid = withRuntime(withBytecodeFunctions(definition, [builtinFunction]), {
			stringConstants: [[120]],
		});
		const restored = deserializeCompilerArtifact(
			serializeCompilerArtifact(valid, { debugInfo: false }),
		);
		expect(restored.runtime.functions[0]!.instructions).toEqual([call]);

		const withCall = (replacement: BytecodeInstruction): ProgramImage =>
			withRuntime(valid, {
				functions: [{ ...valid.runtime.functions[0]!, instructions: [replacement] }],
			});
		expect(() =>
			serializeCompilerArtifact(
				withCall({
					...call,
					thisValue: encodeVmValueOperand(-1, { kind: "string", index: 1 }),
				}),
			),
		).toThrow(/invalid VM value operand/);
		expect(() =>
			serializeCompilerArtifact(withCall({ ...call, arguments: [2], argumentCount: 1 })),
		).toThrow(/invalid VM value operand/);
		expect(() =>
			serializeCompilerArtifact(
				withCall({ ...call, arguments: [-300_000_000], argumentCount: 1 }),
			),
		).toThrow(/invalid VM value operand/);
	});

	it("covers every opcode in the wire table", () => {
		// Guard: the canonical opcode list and the lowering union stay in sync.
		expect(new Set(WIRE_OPCODES).size).toBe(WIRE_OPCODES.length);
		expect(WIRE_OPCODES.slice(-17)).toEqual([
			"INIT_GLOBAL_VARS",
			"CREATE_PRIVATE_NAMES",
			"INIT_PRIVATE_FIELDS",
			"TYPEOF_COMPARE",
			"TERMINAL_YIELD",
			"CONSTRUCT_SUPER_EXPLICIT",
			"SET_THIS",
			"LOAD_STATIC_ARGUMENT",
			"CALL_SPREAD_ITERABLE",
			"MATH_UNARY_NUMBER",
			"MATH_BINARY_NUMBER",
			"CALL_BUILTIN",
			"LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
			"STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
			"SELECT_SHAPE_CASE",
			"LOAD_PROPERTY_STATIC_SHAPE_CASE",
			"LOAD_PROPERTY_STATIC_ARRAY_LENGTH",
		]);
	});

	it("round-trips and rejects tampered known-own-slot access metadata", () => {
		const valid = knownOwnSlotDefinition();
		const wire = serializeCompilerArtifact(valid, { debugInfo: false });
		const restored = deserializeCompilerArtifact(wire);
		expect(restored.runtime.precompiledLiteralShapes).toEqual(
			valid.runtime.precompiledLiteralShapes,
		);
		expect(restored.runtime.functions[0]!.literalShapeCount).toBe(2);
		expect(
			restored.runtime.functions[0]!.instructions.find(
				(instruction) => instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT",
			),
		).toMatchObject({
			stringIndex: 1,
			candidates: [
				{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 1 },
				{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 },
			],
		});
		expect(
			restored.runtime.functions[0]!.instructions.find(
				(instruction) => instruction.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
			),
		).toMatchObject({
			stringIndex: 1,
			candidates: [
				{ shapeFunctionIndex: 0, shapeCacheIndex: 0, slot: 1 },
				{ shapeFunctionIndex: 0, shapeCacheIndex: 1, slot: 0 },
			],
		});

		const malformed = withRuntime(valid, {
			functions: valid.runtime.functions.map((fn, functionIndex) => ({
				...fn,
				instructions: fn.instructions.map((instruction) =>
					functionIndex === 0 &&
					instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
						? {
								...instruction,
								candidates: [{ ...instruction.candidates[0]!, slot: 0 }],
							}
						: instruction,
				),
			})),
		});
		expect(() => serializeCompilerArtifact(malformed)).toThrow(
			/invalid known-own-slot access/,
		);
		const duplicate = withRuntime(valid, {
			functions: valid.runtime.functions.map((fn, functionIndex) => ({
				...fn,
				instructions: fn.instructions.map((instruction) =>
					functionIndex === 0 &&
					instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
						? {
								...instruction,
								candidates: [instruction.candidates[0]!, instruction.candidates[0]!],
							}
						: instruction,
				),
			})),
		});
		expect(() => serializeCompilerArtifact(duplicate)).toThrow(
			/invalid known-own-slot access/,
		);
		const extraField = withRuntime(valid, {
			functions: valid.runtime.functions.map((fn, functionIndex) => ({
				...fn,
				instructions: fn.instructions.map((instruction) =>
					functionIndex === 0 &&
					instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
						? {
								...instruction,
								candidates: [{ ...instruction.candidates[0]!, unexpected: true }],
							}
						: instruction,
				),
			})),
		});
		expect(() => serializeCompilerArtifact(extraField)).toThrow(
			/invalid known-own-slot access/,
		);
		const negativeZero = withRuntime(valid, {
			functions: valid.runtime.functions.map((fn, functionIndex) => ({
				...fn,
				instructions: fn.instructions.map((instruction) =>
					functionIndex === 0 &&
					instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
						? {
								...instruction,
								candidates: [{ ...instruction.candidates[0]!, slot: -0 }],
							}
						: instruction,
				),
			})),
		});
		expect(() => serializeCompilerArtifact(negativeZero)).toThrow(
			/invalid known-own-slot access/,
		);

		const opcode = WIRE_OPCODES.indexOf("LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT");
		const encodedInstruction = [opcode, 6, 4, 2, 2, 0, 0, 2, 0, 2, 0];
		const instructionOffset = wire.findIndex((_, offset) =>
			encodedInstruction.every((byte, index) => wire[offset + index] === byte),
		);
		expect(instructionOffset).toBeGreaterThanOrEqual(0);
		const tampered = wire.slice();
		// Change the second candidate's slot ZigZag(0) to ZigZag(1), outside its shape.
		tampered[instructionOffset + encodedInstruction.length - 1] = 2;
		expect(() => deserializeCompilerArtifact(tampered)).toThrow(
			/invalid known-own-slot access/,
		);
	});

	it("round-trips and validates shared shape-case loads", () => {
		const valid = shapeCaseDefinition();
		const restored = deserializeCompilerArtifact(
			serializeCompilerArtifact(valid, { debugInfo: false }),
		);
		expect(restored.runtime.functions[0]!.instructions).toEqual(
			valid.runtime.functions[0]!.instructions,
		);

		const oneLoad = withRuntime(valid, {
			functions: valid.runtime.functions.map((fn) => ({
				...fn,
				instructions: fn.instructions
					.filter(
						(instruction) =>
							instruction.opcode !== "LOAD_PROPERTY_STATIC_SHAPE_CASE" ||
							instruction.stringIndex !== 1,
					)
					.map((instruction) =>
						instruction.opcode === "RETURN" ? { ...instruction, value: 4 } : instruction,
					),
			})),
		});
		expect(() => serializeCompilerArtifact(oneLoad)).toThrow(
			/shape-case selector use count/,
		);

		const wrongSlot = withRuntime(valid, {
			functions: valid.runtime.functions.map((fn) => ({
				...fn,
				instructions: fn.instructions.map((instruction) =>
					instruction.opcode === "LOAD_PROPERTY_STATIC_SHAPE_CASE" &&
					instruction.stringIndex === 1
						? { ...instruction, slots: [0] }
						: instruction,
				),
			})),
		});
		expect(() => serializeCompilerArtifact(wrongSlot)).toThrow(/invalid shape-case load/);

		const orphan = withRuntime(valid, {
			functions: valid.runtime.functions.map((fn) => ({
				...fn,
				instructions: fn.instructions.map((instruction) =>
					instruction.opcode === "LOAD_PROPERTY_STATIC_SHAPE_CASE"
						? { ...instruction, shapeCase: 0 }
						: instruction,
				),
			})),
		});
		expect(() => serializeCompilerArtifact(orphan)).toThrow(
			/shape-case selector use count/,
		);

		const barrierInstruction: BytecodeInstruction = {
			opcode: "CREATE_OBJECT",
			dst: 7,
		};
		const barrierFunctions = valid.runtime.functions.map((fn) => ({
			...fn,
			registerCount: 8,
			instructions: [
				...fn.instructions.slice(0, 4),
				barrierInstruction,
				...fn.instructions.slice(4),
			],
		}));
		const barrier = withBytecodeFunctions(valid, barrierFunctions);
		expect(() => serializeCompilerArtifact(barrier)).toThrow(
			/shape-case selector crosses an invalid instruction/,
		);

		const receiverRedefinition = withRuntime(valid, {
			functions: valid.runtime.functions.map((fn) => ({
				...fn,
				instructions: [
					...fn.instructions.slice(0, 5),
					{ opcode: "MOVE", dst: 2, src: 0 } as const,
					...fn.instructions.slice(5),
				],
			})),
		});
		expect(() => serializeCompilerArtifact(receiverRedefinition)).toThrow(
			/shape-case selector receiver is redefined/,
		);

		const encoded = serializeCompilerArtifact(valid, { debugInfo: false });
		const loadTag = WIRE_OPCODES.indexOf("LOAD_PROPERTY_STATIC_SHAPE_CASE");
		const encodedFirstLoad = [loadTag, 8, 4, 6, 0, 1, 0];
		const firstLoadOffset = encoded.findIndex((_, offset) =>
			encodedFirstLoad.every((byte, index) => encoded[offset + index] === byte),
		);
		expect(firstLoadOffset).toBeGreaterThanOrEqual(0);
		const receiverClobberWire = encoded.slice();
		// Make the first of two loads overwrite r2, the selector's receiver.
		receiverClobberWire[firstLoadOffset + 1] = 4;
		expect(() => deserializeCompilerArtifact(receiverClobberWire)).toThrow(
			/shape-case selector receiver is redefined/,
		);
	});

	it("validates portable precompiled shape descriptors independently of bytecode", () => {
		const valid = knownOwnSlotDefinition();
		expect(() =>
			serializeCompilerArtifact(withRuntime(valid, { precompiledLiteralShapes: [] })),
		).toThrow(/invalid known-own-slot access/);
		expect(() =>
			serializeCompilerArtifact(
				withRuntime(valid, {
					precompiledLiteralShapes: [
						valid.runtime.precompiledLiteralShapes[0]!,
						valid.runtime.precompiledLiteralShapes[0]!,
					],
				}),
			),
		).toThrow(/invalid precompiled literal shape/);

		for (const units of [[0x30], [..."__proto__"].map((unit) => unit.charCodeAt(0))]) {
			expect(() =>
				serializeCompilerArtifact(
					withRuntime(valid, {
						stringConstants: [...valid.runtime.stringConstants, units],
						precompiledLiteralShapes: [
							{
								functionIndex: 0,
								shapeCacheIndex: 0,
								keyStringIndices: [valid.runtime.stringConstants.length],
							},
						],
					}),
				),
			).toThrow(/invalid precompiled literal shape/);
		}

		expect(() =>
			serializeCompilerArtifact(
				withRuntime(valid, {
					stringConstants: [
						...valid.runtime.stringConstants,
						[...valid.runtime.stringConstants[0]!],
					],
					precompiledLiteralShapes: [
						{
							functionIndex: 0,
							shapeCacheIndex: 0,
							keyStringIndices: [0, valid.runtime.stringConstants.length],
						},
					],
				}),
			),
		).toThrow(/invalid precompiled literal shape/);
	});

	it("round-trips a definition with debug info", () => {
		const restored = deserializeCompilerArtifact(
			serializeCompilerArtifact(definition, { debugInfo: true }),
		);
		expect(restored).toEqual(definition);
	});

	it("round-trips portable exact and guarded script targets", () => {
		const exactInstructions: Array<BytecodeInstruction> = [
			{
				opcode: "CALL",
				dst: 0,
				callee: 1,
				thisValue: 2,
				exactFunctionIndex: 1,
				argumentCount: 0,
				arguments: [],
			},
			{
				opcode: "CONSTRUCT",
				dst: 0,
				callee: 1,
				exactFunctionIndex: 1,
				argumentCount: 0,
				arguments: [],
			},
			{
				opcode: "CALL",
				dst: 0,
				callee: 1,
				thisValue: 2,
				guardedFunctionIndices: [0, 1],
				argumentCount: 0,
				arguments: [],
			},
		];
		const runtimeProbe = withBytecodeFunctions(definition, [
			{
				...mainFn,
				instructions: exactInstructions,
				positions: [0, 0, 0],
				handlers: [],
			},
			genFn,
		]);
		const probe = withNativeFunctionPlan(runtimeProbe, 0, (plan) => ({
			...plan,
			instructions: plan.instructions.with(2, {
				kind: "call",
				guardedFunctionIndices: [0, 1],
			}),
		}));
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(probe));
		expect(restored.runtime.functions[0]!.instructions).toEqual(exactInstructions);
		expect(restored.native.functions[0]!.instructions[2]).toEqual({
			kind: "call",
			guardedFunctionIndices: [0, 1],
		});
	});

	it("round-trips and validates guarded Math call hints", () => {
		const calls: Array<BytecodeInstruction> = [
			{
				opcode: "CALL",
				dst: 0,
				callee: 1,
				thisValue: 2,
				guardedMathCall: { kind: "unary", operation: "Math.round" },
				argumentCount: 1,
				arguments: [3],
			},
			{
				opcode: "CALL",
				dst: 0,
				callee: 1,
				thisValue: 2,
				guardedMathCall: { kind: "binary", operation: "Math.max" },
				argumentCount: 2,
				arguments: [3, 4],
			},
			{
				opcode: "CALL",
				dst: 0,
				callee: 1,
				thisValue: 2,
				guardedBuiltinCall: { operation: "Map.prototype.set" },
				argumentCount: 2,
				arguments: [3, 4],
			},
			{
				opcode: "CALL",
				dst: 0,
				callee: 1,
				thisValue: 2,
				guardedBuiltinCall: { operation: "Array.prototype.push" },
				argumentCount: 4,
				arguments: [3, 4, 3, 4],
			},
		];
		const withCalls = (instructions: Array<BytecodeInstruction>): ProgramImage =>
			withBytecodeFunctions(definition, [
				{
					...mainFn,
					registerCount: 5,
					instructions,
					positions: instructions.map(() => 0),
					handlers: [],
				},
			]);
		const restored = deserializeCompilerArtifact(
			serializeCompilerArtifact(withCalls(calls), { debugInfo: false }),
		);
		expect(restored.runtime.functions[0]!.instructions).toEqual(calls);
		expect(() =>
			serializeCompilerArtifact(
				withCalls([
					{
						opcode: "CALL",
						dst: 0,
						callee: 1,
						thisValue: 2,
						guardedMathCall: { kind: "unary", operation: "Math.round" },
						argumentCount: 2,
						arguments: [3, 4],
					},
				]),
			),
		).toThrow("invalid guarded Math call");
		expect(() =>
			serializeCompilerArtifact(
				withCalls([
					{
						opcode: "CALL",
						dst: 0,
						callee: 1,
						thisValue: 2,
						guardedMathCall: { kind: "unary", operation: "Math.round" },
						guardedBuiltinCall: { operation: "Map.prototype.get" },
						argumentCount: 1,
						arguments: [3],
					},
				]),
			),
		).toThrow("invalid guarded builtin call");
		expect(() =>
			serializeCompilerArtifact(
				withCalls([
					{
						opcode: "CALL",
						dst: 0,
						callee: 1,
						thisValue: 2,
						guardedBuiltinCall: { operation: "Array.prototype.push" },
						argumentCount: 5,
						arguments: [3, 4, 3, 4, 3],
					},
				]),
			),
		).toThrow("invalid guarded builtin call");
	});

	it("validates stack-object access keys at both wire boundaries", () => {
		const valid = stackObjectDefinition();
		const wire = serializeCompilerArtifact(valid, { debugInfo: false });
		expect(
			deserializeCompilerArtifact(wire).native.functions[0]!.specializations,
		).toEqual(valid.native.functions[0]!.specializations);

		const region = valid.native.functions[0]!.specializations[0]!;
		if (region.kind !== "stack-object-plan") throw new Error("expected stack region");
		const malformed = withNativeFunctionPlan(valid, 0, (plan) => ({
			...plan,
			specializations: [
				{
					...region,
					sites: [
						{
							...region.sites[0]!,
							accesses: [
								{ ip: 3, slot: 1 },
								{ ip: 4, slot: 0 },
							],
						},
					],
				},
			],
		}));
		expect(() => serializeCompilerArtifact(malformed, { debugInfo: false })).toThrow(
			/invalid stack-object plan region/,
		);

		const tampered = wire.slice();
		// The single site's access slot is followed by inheritedIp=-1 and an empty
		// materialization table. Change ZigZag(1) to ZigZag(0) without changing size.
		expect(tampered.at(-3)).toBe(2);
		tampered[tampered.length - 3] = 0;
		expect(() => deserializeCompilerArtifact(tampered)).toThrow(
			/invalid stack-object plan region/,
		);
	});

	it("requires one Core-selected physical representation per register", () => {
		expect(() =>
			serializeCompilerArtifact(
				withNativeFunctionPlan(definition, 0, (plan) => ({
					...plan,
					registerRepresentations: plan.registerRepresentations.slice(1),
				})),
			),
		).toThrow(/invalid register representations/);
		expect(() =>
			serializeCompilerArtifact(
				withNativeFunctionPlan(definition, 0, (plan) => ({
					...plan,
					registerRepresentations: plan.registerRepresentations.with(0, "number"),
				})),
			),
		).toThrow(/invalid register representations/);
	});

	it("round-trips every guarded builtin with world and epoch dependencies", () => {
		const operations = VM_GUARDED_BUILTIN_OPERATIONS;
		const dependencies = [
			{ kind: "world", fact: "primordials.locked" },
			{ kind: "epoch", family: "watched-methods" },
		] as const;
		for (const operation of operations) {
			for (const dependency of dependencies) {
				let replaced = false;
				const guardedDefinition = withNativeFunctionPlan(definition, 0, (plan, fn) => ({
					...plan,
					instructions: fn.instructions.map((instruction) => {
						if (replaced || instruction.opcode !== "CALL") return undefined;
						replaced = true;
						return {
							kind: "call",
							guardedBuiltinCall: {
								operation,
								guard: {
									dependencies: [dependency],
									obligations: ["fallback"],
								},
							},
						};
					}),
				}));
				expect(replaced).toBe(true);
				expect(
					deserializeCompilerArtifact(serializeCompilerArtifact(guardedDefinition)),
				).toEqual(guardedDefinition);
			}
		}
	});

	it("round-trips program-level semantic protector facts", () => {
		const semanticDefinition: ProgramImage = {
			...definition,
			native: {
				...definition.native,
				semanticProtectors: [
					{
						family: "primitive-methods",
						guard: {
							dependencies: [{ kind: "world", fact: "primordials.locked" }],
							obligations: ["fallback"],
						},
					},
					{
						family: "watched-methods",
						guard: {
							dependencies: [{ kind: "epoch", family: "watched-methods" }],
							obligations: ["fallback"],
						},
					},
					{
						family: "array-elements",
						guard: {
							dependencies: [{ kind: "epoch", family: "array-elements" }],
							obligations: ["fallback"],
						},
					},
				],
			},
		};
		expect(
			deserializeCompilerArtifact(serializeCompilerArtifact(semanticDefinition)),
		).toEqual(semanticDefinition);
	});
	it("retains native-code generation metadata for frontend cache hits", () => {
		const metadataInstructions: Array<BytecodeInstruction> = mainFn.instructions.map(
			(instruction) => {
				if (instruction.opcode === "LOAD_PROPERTY_STATIC") {
					return { ...instruction, stringIndex: 3 };
				}
				if (instruction.opcode === "CALL") {
					return { ...instruction, exactFunctionIndex: 0 };
				}
				return instruction;
			},
		);
		metadataInstructions.push({
			opcode: "CONSTRUCT",
			dst: 1,
			callee: 2,
			exactFunctionIndex: 0,
			argumentCount: 1,
			arguments: [3],
		});
		const nativeInstructions: Array<NativeInstructionPlan | undefined> =
			metadataInstructions.map((instruction) => {
				if (instruction.opcode === "LOAD_PROPERTY_STATIC") {
					return { kind: "primitive-string-length" };
				}
				if (instruction.opcode === "CALL") {
					return {
						kind: "call",
						directFunctionIndex: 0,
						directEntryId: 0,
						directFunctionCall: true,
						directCallTargetFunctionIndex: 0,
						guardedBuiltinCall: {
							operation: "String.prototype.charCodeAt",
							guard: {
								dependencies: [{ kind: "world", fact: "primordials.locked" }],
								obligations: ["fallback"],
							},
						},
						directStringCharCodeAtPosition: "inBounds",
					};
				}
				if (instruction.opcode === "CONSTRUCT") {
					return { kind: "construct", directFunctionIndex: 0 };
				}
				return undefined;
			});
		const cachedFunctions: Array<BytecodeFunction> = [
			{
				...mainFn,
				instructions: metadataInstructions,
				positions: [
					...mainFn.positions,
					...Array.from(
						{
							length: metadataInstructions.length - mainFn.instructions.length,
						},
						() => 2,
					),
				],
			},
		];
		const cachedDefinition = withNativeFunctionPlan(
			withBytecodeFunctions(
				withRuntime(definition, {
					stringConstants: [
						...definition.runtime.stringConstants,
						[..."length"].map((character) => character.charCodeAt(0)),
					],
				}),
				cachedFunctions,
			),
			0,
			(plan) => ({
				...plan,
				registerRepresentations: plan.registerRepresentations.map(
					(representation, register) =>
						register === 1 ? ("string" as const) : representation,
				),
				directEntries: [
					{
						id: 0,
						parameterRepresentations: ["int32"],
						resultRepresentation: "string",
						registerRepresentations: plan.registerRepresentations.map(
							(representation, register) =>
								register === 0
									? ("int32" as const)
									: register === 1
										? ("string" as const)
										: representation,
						),
						gc: {
							safepoints: plan.gc.safepoints.map((safepoint) => ({
								...safepoint,
								kind:
									safepoint.kind === "conservative"
										? ("operation" as const)
										: safepoint.kind,
								rootRegisters: safepoint.rootRegisters.filter(
									(register) => register !== 0,
								),
							})),
						},
					},
				],
				instructions: nativeInstructions,
			}),
		);

		expect(
			deserializeCompilerArtifact(serializeCompilerArtifact(cachedDefinition)),
		).toEqual(cachedDefinition);
	});

	it("validates fresh dense indexed-fill reserve metadata", () => {
		const reserveDefinition = (reserveLength: number): ProgramImage =>
			withNativeFunctionPlan(
				withBytecodeFunctions(definition, [
					{
						...mainFn,
						registerCount: 1,
						instructions: [
							{
								opcode: "CREATE_ARRAY",
								dst: 0,
								length: 0,
							},
						],
						positions: [0],
						handlers: [],
					},
				]),
				0,
				(plan) => ({
					...plan,
					instructions: [{ kind: "fresh-dense-reserve", length: reserveLength }],
				}),
			);

		for (const invalid of [0, 65_537]) {
			expect(() => serializeCompilerArtifact(reserveDefinition(invalid))).toThrow(
				/invalid indexed-fill reserve metadata/,
			);
		}

		const malformed = serializeCompilerArtifact(reserveDefinition(1), {
			debugInfo: false,
		});
		// The instruction metadata ends in tag 12 + ZigZag i32(1), followed by
		// the empty tagged function-region table.
		expect(malformed.at(-3)).toBe(12);
		malformed[malformed.length - 2] = 0;
		expect(() => deserializeCompilerArtifact(malformed)).toThrow(
			/invalid indexed-fill reserve metadata/,
		);
	});

	it("round-trips portable exact Array length operations and rejects stale proofs", () => {
		const exactArrayLengthDefinition = (
			stringConstants: Array<Array<number>>,
			object = 1,
		): ProgramImage => {
			const image = withRuntime(
				withBytecodeFunctions(definition, [
					{
						...mainFn,
						registerCount: 2,
						instructions: [
							{ opcode: "CREATE_ARRAY", dst: 1, length: 3 },
							{
								opcode: "LOAD_PROPERTY_STATIC_ARRAY_LENGTH",
								dst: 0,
								object,
								stringIndex: 0,
								icIndex: 0,
							},
							{ opcode: "RETURN", value: 0 },
						],
						positions: [0, 0, 0],
						handlers: [],
					},
				]),
				{ stringConstants },
			);
			return withNativeFunctionPlan(image, 0, (plan) => ({
				...plan,
				instructions: [undefined, { kind: "exact-array-length" }, undefined],
			}));
		};
		const length = Array.from("length", (unit) => unit.charCodeAt(0));
		const valid = exactArrayLengthDefinition([length]);
		expect(deserializeCompilerArtifact(serializeCompilerArtifact(valid))).toEqual(valid);

		expect(() =>
			serializeCompilerArtifact(
				exactArrayLengthDefinition([Array.from("other", (unit) => unit.charCodeAt(0))]),
			),
		).toThrow(/invalid exact Array length operation/);
		expect(() =>
			serializeCompilerArtifact(exactArrayLengthDefinition([length], 2)),
		).toThrow(/invalid exact Array length operation/);
	});

	it("round-trips and rejects operation-local specialization facts", () => {
		const withInstruction = (
			instruction: BytecodeInstruction,
			nativeInstruction: NativeInstructionPlan,
		): ProgramImage =>
			withNativeFunctionPlan(
				withBytecodeFunctions(definition, [
					{
						...mainFn,
						registerCount: 4,
						instructions: [instruction],
						positions: [0],
						handlers: [],
					},
				]),
				0,
				(plan) => ({ ...plan, instructions: [nativeInstruction] }),
			);
		const exactTypedArrayStore = withInstruction(
			{
				opcode: "STORE_PROPERTY",
				object: 0,
				key: 1,
				value: 2,
				icIndex: 0,
			},
			{ kind: "exact-typed-array-element", elementKind: "Uint16Array" },
		);
		expect(
			deserializeCompilerArtifact(serializeCompilerArtifact(exactTypedArrayStore)),
		).toEqual(exactTypedArrayStore);

		expect(() =>
			serializeCompilerArtifact(
				withInstruction(
					{
						opcode: "LOAD_PROPERTY_STATIC",
						dst: 0,
						object: 1,
						stringIndex: 1,
						icIndex: 0,
					},
					{ kind: "primitive-string-length" },
				),
			),
		).toThrow(/invalid primitive-String length hint/);
		expect(() =>
			serializeCompilerArtifact(
				withInstruction(
					{
						opcode: "CALL",
						dst: 0,
						callee: 1,
						thisValue: 2,
						argumentCount: 0,
						arguments: [],
					},
					{ kind: "call", directCallTargetFunctionIndex: 0 },
				),
			),
		).toThrow(/invalid CALL specialization metadata/);
		expect(() =>
			serializeCompilerArtifact(
				withInstruction(
					{
						opcode: "CONSTRUCT",
						dst: 0,
						callee: 1,
						argumentCount: 0,
						arguments: [],
					},
					{ kind: "construct", directFunctionIndex: 1 },
				),
			),
		).toThrow(/invalid direct CONSTRUCT target/);
		expect(() =>
			serializeCompilerArtifact(
				withInstruction(
					{
						opcode: "CALL",
						dst: 0,
						callee: 1,
						thisValue: 2,
						exactFunctionIndex: 0,
						argumentCount: 0,
						arguments: [],
					},
					{ kind: "call" },
				),
			),
		).toThrow(/invalid CALL specialization metadata/);
		expect(() =>
			serializeCompilerArtifact(
				withInstruction(
					{
						opcode: "CALL",
						dst: 0,
						callee: 1,
						thisValue: 2,
						guardedFunctionIndices: [0],
						argumentCount: 0,
						arguments: [],
					},
					{ kind: "call" },
				),
			),
		).toThrow(/invalid CALL specialization metadata/);
	});

	it("requires dense property IC ordinals while keeping them implicit on the wire", () => {
		const invalidInstructions = instructions.map((instruction) =>
			instruction.opcode === "LOAD_PROPERTY_STATIC"
				? { ...instruction, icIndex: 1 }
				: instruction,
		);
		expect(() =>
			serializeCompilerArtifact(
				withRuntime(definition, {
					functions: [{ ...mainFn, instructions: invalidInstructions }],
				}),
			),
		).toThrow("property IC index 1, expected 0");
	});

	it("requires dense literal-shape ordinals while keeping them implicit on the wire", () => {
		const invalidInstructions = instructions.map((instruction) =>
			instruction.opcode === "CREATE_OBJECT_SHAPED"
				? { ...instruction, shapeCacheIndex: 1 }
				: instruction,
		);
		expect(() =>
			serializeCompilerArtifact(
				withRuntime(definition, {
					functions: [{ ...mainFn, instructions: invalidInstructions }],
				}),
			),
		).toThrow("literal shape index 1, expected 0");
	});

	it("round-trips and validates persisted argument snapshot prefixes", () => {
		const snapshotInstructions: Array<BytecodeInstruction> = [
			{ opcode: "LOAD_ARGUMENT_COUNT", dst: 1 },
			{ opcode: "LOAD_ARGUMENT", dst: 2, index: 4 },
			{ opcode: "RETURN", value: 2 },
		];
		const snapshotDefinition = withBytecodeFunctions(definition, [
			{
				...mainFn,
				argumentSnapshotCount: 2,
				argumentSnapshotPlan: [
					{ destination: 1, source: -1 },
					{ destination: 2, source: 4 },
				],
				registerCount: 3,
				instructions: snapshotInstructions,
				handlers: [],
				positions: snapshotInstructions.map(() => 0),
			},
		]);
		const restored = deserializeCompilerArtifact(
			serializeCompilerArtifact(snapshotDefinition),
		);
		expect(restored.runtime.functions[0]!.argumentSnapshotCount).toBe(2);
		expect(restored.runtime.functions[0]!.instructions).toEqual(snapshotInstructions);

		expect(() =>
			serializeCompilerArtifact(
				withRuntime(snapshotDefinition, {
					functions: [
						{
							...snapshotDefinition.runtime.functions[0]!,
							argumentSnapshotCount: 1,
						},
					],
				}),
			),
		).toThrow("argument snapshot prefix mismatch");
	});

	it("precomputes cycle-safe argument snapshot move plans", () => {
		const plan = (
			snapshotInstructions: Array<BytecodeInstruction>,
			registerCount: number,
		) =>
			buildArgumentSnapshotPlan({
				argumentSnapshotCount: snapshotInstructions.length,
				instructions: snapshotInstructions,
				parameterCount: 0,
				registerCount,
			});

		expect(
			plan(
				[
					{ opcode: "LOAD_ARGUMENT", dst: 0, index: 1 },
					{ opcode: "LOAD_ARGUMENT", dst: 1, index: 0 },
				],
				2,
			),
		).toEqual([
			{ destination: -1, source: 1 },
			{ destination: 1, source: 0 },
			{ destination: 0, source: -2 },
		]);
		expect(
			plan(
				[
					{ opcode: "LOAD_ARGUMENT", dst: 0, index: 1 },
					{ opcode: "LOAD_ARGUMENT", dst: 1, index: 2 },
					{ opcode: "LOAD_ARGUMENT", dst: 2, index: 0 },
				],
				3,
			),
		).toEqual([
			{ destination: -1, source: 1 },
			{ destination: 1, source: 2 },
			{ destination: 2, source: 0 },
			{ destination: 0, source: -2 },
		]);
		expect(
			plan(
				[
					{ opcode: "LOAD_ARGUMENT_COUNT", dst: 0 },
					{ opcode: "LOAD_ARGUMENT", dst: 1, index: 0 },
				],
				2,
			),
		).toEqual([
			{ destination: 1, source: 0 },
			{ destination: 0, source: -1 },
		]);
	});

	it("is a fixed point (re-serializing yields identical bytes)", () => {
		const buf1 = serializeCompilerArtifact(definition, { debugInfo: true });
		const buf2 = serializeCompilerArtifact(deserializeCompilerArtifact(buf1), {
			debugInfo: true,
		});
		expect(Array.from(buf2)).toEqual(Array.from(buf1));
	});

	it("rejects stale wire versions", () => {
		const buffer = serializeCompilerArtifact(definition);
		new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(
			4,
			COMPILER_ARTIFACT_VERSION - 1,
			true,
		);
		expect(() => deserializeCompilerArtifact(buffer)).toThrow(
			`version ${COMPILER_ARTIFACT_VERSION - 1}, expected ${COMPILER_ARTIFACT_VERSION}`,
		);
	});

	it("drops debug tables when debugInfo is false", () => {
		const restored = deserializeCompilerArtifact(
			serializeCompilerArtifact(definition, { debugInfo: false }),
		);
		expect(restored.runtime.files).toEqual([]);
		expect(restored.runtime.sourcePositions).toEqual([]);
		for (const fn of restored.runtime.functions) {
			expect(fn.positions).toEqual([]);
			expect(fn.fileIndex).toBe(0);
		}
		// Non-debug payload survives intact.
		expect(restored.runtime.functions[0]!.instructions).toEqual(mainFn.instructions);
		expect(restored.runtime.bigintConstants).toEqual(definition.runtime.bigintConstants);
		expect(restored.runtime.stringConstants).toEqual(definition.runtime.stringConstants);
	});

	it("preserves astral code units and signed >64-bit bigints", () => {
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(definition));
		expect(restored.runtime.stringConstants[2]).toEqual([0xd83d, 0xde00]);
		expect(restored.runtime.bigintConstants[1]).toBe(-((1n << 100n) + 7n));
	});

	it("uses canonical u32 LEB128 at count boundaries", () => {
		for (const [count, encoding] of [
			[0, [0]],
			[127, [127]],
			[128, [0x80, 1]],
			[16_383, [0xff, 0x7f]],
			[16_384, [0x80, 0x80, 1]],
		] as const) {
			const functions: Array<BytecodeFunction> = [];
			const probe: ProgramImage = {
				...withRuntime(definition, {
					functions: [],
					functionCount: 0,
					stringConstants: [],
					bigintConstants: [],
					literalTemplateData: new Array<number>(count).fill(0xffffffff),
					files: [],
					sourcePositions: [],
					cjsModuleFunctionIndices: [],
				}),
				native: createConservativeNativePlan(functions),
			};
			const wire = serializeCompilerArtifact(probe, { debugInfo: false });
			// Fixed magic/version, one-byte flags/global/entry length, the entry bytes,
			// then one-byte string and bigint counts.
			const literalCountOffset =
				13 + new TextEncoder().encode(probe.runtime.entrypointPath).length;
			expect(
				Array.from(
					wire.subarray(literalCountOffset, literalCountOffset + encoding.length),
				),
			).toEqual(encoding);
			expect(deserializeCompilerArtifact(wire).runtime.literalTemplateData).toEqual(
				probe.runtime.literalTemplateData,
			);
		}
	});

	it("rejects truncated, overflowing, and non-canonical varints", () => {
		const wire = serializeCompilerArtifact(definition, { debugInfo: false });
		const replaceFlags = (bytes: Array<number>): Uint8Array =>
			Uint8Array.from([...wire.subarray(0, 8), ...bytes, ...wire.subarray(9)]);

		expect(() =>
			deserializeCompilerArtifact(Uint8Array.from([...wire.subarray(0, 8), 0x80])),
		).toThrow();
		expect(() =>
			deserializeCompilerArtifact(replaceFlags([0x80, 0x80, 0x80, 0x80, 0x10])),
		).toThrow(/invalid u32 varint/);
		expect(() => deserializeCompilerArtifact(replaceFlags([0x80, 0]))).toThrow(
			/non-canonical u32 varint/,
		);
	});

	it("rejects trailing data", () => {
		const wire = serializeCompilerArtifact(definition);
		expect(() => deserializeCompilerArtifact(Uint8Array.from([...wire, 0]))).toThrow(
			/trailing data/,
		);
	});

	it("rejects negative direct argument indices", () => {
		const probe = withBytecodeFunctions(definition, [
			{
				...mainFn,
				argumentSnapshotCount: 1,
				instructions: [{ opcode: "LOAD_ARGUMENT", dst: 1, index: -1 }],
			},
		]);
		expect(() => serializeCompilerArtifact(probe)).toThrow(/negative argument index/);
	});

	it("rejects out-of-range portable exact script-function targets", () => {
		const probe = withRuntime(definition, {
			functions: [
				{
					...mainFn,
					instructions: [
						{
							opcode: "CONSTRUCT",
							dst: 0,
							callee: 1,
							exactFunctionIndex: 1,
							argumentCount: 0,
							arguments: [],
						},
					],
				},
			],
			functionCount: 1,
		});
		expect(() => serializeCompilerArtifact(probe)).toThrow(
			/invalid exact script-function target/,
		);
	});

	it.each([
		[[0, 0], undefined],
		[[1, 0], undefined],
		[[0, 2], undefined],
		[[0, 1], 0],
	])("rejects non-canonical portable guarded script targets", (targets, exact) => {
		const probe = withRuntime(definition, {
			functions: definition.runtime.functions.map((fn, functionIndex) =>
				functionIndex !== 0
					? fn
					: {
							...fn,
							instructions: [
								{
									opcode: "CALL",
									dst: 0,
									callee: 1,
									thisValue: 2,
									...(exact === undefined ? {} : { exactFunctionIndex: exact }),
									guardedFunctionIndices: targets,
									argumentCount: 0,
									arguments: [],
								},
							],
						},
			),
		});
		expect(() => serializeCompilerArtifact(probe)).toThrow(
			/invalid guarded script-function targets/,
		);
	});

	it.each([
		[0, [], []],
		[65, new Array<number>(65).fill(0), new Array<number>(65).fill(0)],
		[2, [0], [0, 1]],
		[2, [0, 1], [0]],
	])(
		"rejects invalid shaped object operands",
		(count, keyStringIndices, valueRegisters) => {
			const probe = withBytecodeFunctions(definition, [
				{
					...mainFn,
					instructions: [
						{
							opcode: "CREATE_OBJECT_SHAPED",
							dst: 0,
							count,
							keyStringIndices,
							valueRegisters,
							shapeCacheIndex: 0,
						},
					],
				},
			]);
			expect(() => serializeCompilerArtifact(probe)).toThrow(
				/invalid shaped object operands/,
			);
		},
	);

	it("drops the vestigial TRY_BEGIN.handlerIp (restored as 0)", () => {
		const probe: ProgramImage = testProgramImage({
			entrypointPath: "/fixture/entry.mjs",
			functionCount: 1,
			functions: [
				{
					...genFn,
					instructions: [{ opcode: "TRY_BEGIN", handlerIp: 99 }, { opcode: "TRY_END" }],
					positions: [0, 0],
					handlers: [],
				},
			],
			stringConstants: [],
			bigintConstants: [],
			literalTemplateData: [],
			precompiledLiteralShapes: [],
			globalCount: 0,
			files: [],
			sourcePositions: [],
			cjsModuleFunctionIndices: [],
			hostInstalls: [],
		});
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(probe));
		expect(restored.runtime.functions[0]!.instructions[0]).toEqual({
			opcode: "TRY_BEGIN",
			handlerIp: 0,
		});
	});

	it("rejects a buffer with a bad magic", () => {
		const buf = serializeCompilerArtifact(definition);
		buf[0] = 0;
		expect(() => deserializeCompilerArtifact(buf)).toThrow(/bad magic/);
	});

	it("round-trips portable host install manifests", () => {
		const restored = deserializeCompilerArtifact(
			serializeCompilerArtifact(hostDefinition),
		);
		expect(restored.runtime.hostInstalls).toEqual(hostDefinition.runtime.hostInstalls);
	});

	it("rejects string constants above the runtime UTF-16 limit", () => {
		const oversized = withRuntime(definition, {
			stringConstants: [new Array<number>(MAX_STRING_CODE_UNITS + 1)],
		});
		expect(() => serializeCompilerArtifact(oversized)).toThrow(
			/string constant has .* UTF-16 code units/,
		);
	});

	it("retains host installs in a stripped runtime image", () => {
		const restored = deserializeCompilerArtifact(
			serializeCompilerArtifact(hostDefinition, { debugInfo: false }),
		);
		expect(restored.runtime.hostInstalls).toEqual(hostDefinition.runtime.hostInstalls);
	});

	it("rejects a truncated host-install manifest", () => {
		const buffer = serializeCompilerArtifact(definition);
		buffer[buffer.byteLength - 1] = 1;
		expect(() => deserializeCompilerArtifact(buffer)).toThrow(/truncated|corrupt|read/);
	});

	it("round-trips an ordinary runtime image with an empty manifest", () => {
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(definition));
		expect(restored.runtime.hostInstalls).toEqual([]);
	});
});
