import { describe, expect, it } from "vitest";
import {
	buildArgumentSnapshotPlan,
	VM_GUARDED_BUILTIN_OPERATIONS,
} from "../src/lower-vm.ts";
import type { VmDefinition, VmFunction, VmInstruction } from "../src/lower-vm.ts";
import {
	deserializeVmDefinition,
	MAX_STRING_CODE_UNITS,
	serializeVmDefinition,
	WIRE_OPCODES,
	WIRE_VERSION,
} from "../src/serialize-vm.ts";

// A definition exercising the tricky encodings: variable-length operand arrays
// (CALL / CREATE_OBJECT_SHAPED / CREATE_MODULE_NAMESPACE / CREATE_TEMPLATE_OBJECT /
// COPY_DATA_PROPERTIES / INIT_GLOBAL_VARS / CREATE_PRIVATE_NAMES /
// INIT_PRIVATE_FIELDS), no-fallback numeric Math, the f64 / boolean / enum /
// u16-intrinsic operands,
// strings (incl. astral code units), bigints (incl. > 64 bits), handlers, the
// vestigial TRY_BEGIN (handlerIp dropped → 0), and debug tables.
const instructions: Array<VmInstruction> = [
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
	{ opcode: "LOAD_PROPERTY_STATIC", dst: 7, object: 10, stringIndex: 1, icIndex: 0 },
	{ opcode: "STORE_PROPERTY_STATIC", object: 10, value: 7, stringIndex: 1, icIndex: 1 },
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
	{ opcode: "TYPEOF_COMPARE", dst: 9, src: 8, expected: "number", negated: true },
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
	{ opcode: "CREATE_MODULE_NAMESPACE", dst: 13, nameIndices: [0, 1], slots: [4, 5] },
	{ opcode: "COPY_DATA_PROPERTIES", dst: 14, src: 10, excludedCount: 1, excluded: [3] },
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
	{ opcode: "CREATE_PRIVATE_NAMES", ownerFunctionIndex: 0, capturedIndices: [0, 2] },
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

const mainFn: VmFunction = {
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
	instructions,
	handlers: [{ startIp: 10, endIp: 19, handlerIp: 20 }],
	fileIndex: 0,
	// Canonical (compress→expand fixed-point) per-instruction positions.
	positions: instructions.map((_, ip) => (ip < 11 ? 0 : ip < 20 ? 1 : 2)),
};

const genFn: VmFunction = {
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

const definition: VmDefinition = {
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
	globalCount: 6,
	files: ["compiled://a.js", "compiled://b.ts"],
	sourcePositions: [
		{ line: 1, column: 0 },
		{ line: 2, column: 4 },
		{ line: 3, column: 8, inlinedFunctionIndex: 1, callerPosId: 0 },
	],
	cjsModuleFunctionIndices: [1],
	hostInstalls: [],
};

const hostDefinition: VmDefinition = {
	...definition,
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
};

describe("serialize-vm", () => {
	it("covers every opcode in the wire table", () => {
		// Guard: the canonical opcode list and the lowering union stay in sync.
		expect(new Set(WIRE_OPCODES).size).toBe(WIRE_OPCODES.length);
		expect(WIRE_OPCODES.slice(-12)).toEqual([
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
		]);
	});

	it("round-trips a definition with debug info", () => {
		const restored = deserializeVmDefinition(
			serializeVmDefinition(definition, { debugInfo: true }),
		);
		expect(restored).toEqual(definition);
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
				const guardedDefinition: VmDefinition = {
					...definition,
					functions: definition.functions.map((fn) => ({
						...fn,
						instructions: fn.instructions.map((instruction) => {
							if (replaced || instruction.opcode !== "CALL") return instruction;
							replaced = true;
							return {
								...instruction,
								guardedBuiltinCall: {
									operation,
									guard: {
										dependencies: [dependency],
										obligations: ["fallback"],
									},
								},
							};
						}),
					})),
				};
				expect(replaced).toBe(true);
				expect(deserializeVmDefinition(serializeVmDefinition(guardedDefinition))).toEqual(
					guardedDefinition,
				);
			}
		}
	});

	it("round-trips program-level semantic protector facts", () => {
		const semanticDefinition: VmDefinition = {
			...definition,
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
		};
		expect(deserializeVmDefinition(serializeVmDefinition(semanticDefinition))).toEqual(
			semanticDefinition,
		);
	});

	it("retains native-code generation metadata for frontend cache hits", () => {
		const metadataInstructions: Array<VmInstruction> = mainFn.instructions.map(
			(instruction) => {
				if (instruction.opcode === "LOAD_PROPERTY_STATIC") {
					return { ...instruction, nativePrimitiveStringLength: true };
				}
				if (instruction.opcode === "CALL") {
					return {
						...instruction,
						directFunctionIndex: 1,
						directFunctionCall: true,
						directCallTargetFunctionIndex: 1,
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
				if (instruction.opcode === "BINARY") {
					return { ...instruction, nativeNumericFusion: { role: "start", id: 4 } };
				}
				return instruction;
			},
		);
		metadataInstructions.push({
			opcode: "CONSTRUCT",
			dst: 1,
			callee: 2,
			argumentCount: 1,
			arguments: [3],
			directFunctionIndex: 1,
		});
		metadataInstructions.push({
			opcode: "BINARY",
			dst: 8,
			left: 0,
			right: 1,
			operator: "+",
			nativeFiniteString: { minimum: 0, stringIndices: [0, 1, 2] },
		});
		metadataInstructions.push({
			opcode: "LOAD_PROPERTY",
			dst: 9,
			object: 0,
			key: 1,
			icIndex: metadataInstructions.filter((instruction) =>
				[
					"LOAD_PROPERTY",
					"LOAD_PROPERTY_STATIC",
					"STORE_PROPERTY",
					"STORE_PROPERTY_STATIC",
				].includes(instruction.opcode),
			).length,
			nativeFiniteKey: { minimum: 0, ordinal: 1, stringIndices: [0, 1] },
		});
		const finiteStoreIc = metadataInstructions.filter((instruction) =>
			[
				"LOAD_PROPERTY",
				"LOAD_PROPERTY_STATIC",
				"STORE_PROPERTY",
				"STORE_PROPERTY_STATIC",
			].includes(instruction.opcode),
		).length;
		const finiteAllocationInstructionIndex = metadataInstructions.length;
		metadataInstructions.push({
			opcode: "CREATE_OBJECT",
			dst: 7,
			nativeFiniteConstruction: {
				icIndex: finiteStoreIc,
				numberGuards: [1],
				keyStringIndices: [0, 1],
				virtualRecord: true,
			},
		});
		metadataInstructions.push({
			opcode: "STORE_PROPERTY",
			object: 7,
			key: 1,
			value: 2,
			icIndex: finiteStoreIc,
			nativeFiniteKey: { minimum: 0, ordinal: 1, stringIndices: [0, 1] },
		});
		metadataInstructions.push({
			opcode: "LOAD_PROPERTY",
			dst: 9,
			object: 7,
			key: 1,
			icIndex: finiteStoreIc + 1,
			nativeFiniteKey: { minimum: 0, ordinal: 1, stringIndices: [0, 1] },
			nativeFiniteRecordAccess: {
				allocationInstructionIndex: finiteAllocationInstructionIndex,
			},
		});
		metadataInstructions.push({
			opcode: "LOAD_PROPERTY",
			dst: 9,
			object: 7,
			key: 1,
			icIndex: finiteStoreIc + 2,
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
		});
		metadataInstructions.push({
			opcode: "STORE_PROPERTY",
			object: 7,
			key: 1,
			value: 2,
			icIndex: finiteStoreIc + 3,
			nativeClosedGlobalTable: {
				baseIndex: 0,
				stateIndex: 4,
				mask: 3,
				direct: false,
				guard: {
					dependencies: [{ kind: "world", fact: "primordials.locked" }],
					obligations: ["fallback", "materialize"],
				},
			},
		});
		metadataInstructions.push({
			opcode: "CREATE_ARRAY",
			dst: 6,
			length: 0,
			nativeFreshDenseReserveLength: 65_536,
		});
		const exactArrayAllocationInstructionIndex = metadataInstructions.length - 1;
		metadataInstructions.push({
			opcode: "LOAD_PROPERTY",
			dst: 9,
			object: 6,
			key: 1,
			icIndex: metadataInstructions.filter((instruction) =>
				[
					"LOAD_PROPERTY",
					"LOAD_PROPERTY_STATIC",
					"STORE_PROPERTY",
					"STORE_PROPERTY_STATIC",
				].includes(instruction.opcode),
			).length,
			nativeExactFreshArrayAccess: {
				allocationInstructionIndex: exactArrayAllocationInstructionIndex,
			},
		});
		const cachedDefinition: VmDefinition = {
			...definition,
			functionCount: 1,
			functions: [
				{
					...mainFn,
					instructions: metadataInstructions,
					positions: [
						...mainFn.positions,
						...Array.from(
							{ length: metadataInstructions.length - mainFn.instructions.length },
							() => 2,
						),
					],
					gcRootRegisters: [0, 3, 7],
					stackObjectSites: [{ instructionIndex: 4, slotCount: 2 }],
					stackObjectAccesses: [
						{ instructionIndex: 8, allocationInstructionIndex: 4, slot: 1 },
					],
					stackObjectMaterializations: [
						{ returnInstructionIndex: 10, allocationInstructionIndex: 4 },
					],
				},
			],
		};

		expect(deserializeVmDefinition(serializeVmDefinition(cachedDefinition))).toEqual(
			cachedDefinition,
		);
	});

	it("validates fresh dense indexed-fill reserve metadata", () => {
		const reserveDefinition = (reserveLength: number): VmDefinition => ({
			...definition,
			functionCount: 1,
			functions: [
				{
					...mainFn,
					registerCount: 1,
					instructions: [
						{
							opcode: "CREATE_ARRAY",
							dst: 0,
							length: 0,
							nativeFreshDenseReserveLength: reserveLength,
						},
					],
					positions: [0],
					handlers: [],
				},
			],
		});

		for (const invalid of [0, 65_537]) {
			expect(() => serializeVmDefinition(reserveDefinition(invalid))).toThrow(
				/invalid indexed-fill reserve metadata/,
			);
		}

		const malformed = serializeVmDefinition(reserveDefinition(1), {
			debugInfo: false,
		});
		// The instruction metadata ends in tag 12 + ZigZag i32(1), followed by
		// the empty numeric-HOF region table.
		expect(malformed.at(-3)).toBe(12);
		malformed[malformed.length - 2] = 0;
		expect(() => deserializeVmDefinition(malformed)).toThrow(
			/invalid indexed-fill reserve metadata/,
		);
	});

	it("requires dense property IC ordinals while keeping them implicit on the wire", () => {
		const invalidInstructions = instructions.map((instruction) =>
			instruction.opcode === "LOAD_PROPERTY_STATIC"
				? { ...instruction, icIndex: 1 }
				: instruction,
		);
		expect(() =>
			serializeVmDefinition({
				...definition,
				functions: [{ ...mainFn, instructions: invalidInstructions }],
			}),
		).toThrow("property IC index 1, expected 0");
	});

	it("requires dense literal-shape ordinals while keeping them implicit on the wire", () => {
		const invalidInstructions = instructions.map((instruction) =>
			instruction.opcode === "CREATE_OBJECT_SHAPED"
				? { ...instruction, shapeCacheIndex: 1 }
				: instruction,
		);
		expect(() =>
			serializeVmDefinition({
				...definition,
				functions: [{ ...mainFn, instructions: invalidInstructions }],
			}),
		).toThrow("literal shape index 1, expected 0");
	});

	it("round-trips and validates persisted argument snapshot prefixes", () => {
		const snapshotInstructions: Array<VmInstruction> = [
			{ opcode: "LOAD_ARGUMENT_COUNT", dst: 1 },
			{ opcode: "LOAD_ARGUMENT", dst: 2, index: 4 },
			{ opcode: "RETURN", value: 2 },
		];
		const snapshotDefinition: VmDefinition = {
			...definition,
			functionCount: 1,
			functions: [
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
			],
		};
		const restored = deserializeVmDefinition(serializeVmDefinition(snapshotDefinition));
		expect(restored.functions[0]!.argumentSnapshotCount).toBe(2);
		expect(restored.functions[0]!.instructions).toEqual(snapshotInstructions);

		expect(() =>
			serializeVmDefinition({
				...snapshotDefinition,
				functions: [{ ...snapshotDefinition.functions[0]!, argumentSnapshotCount: 1 }],
			}),
		).toThrow("argument snapshot prefix mismatch");
	});

	it("precomputes cycle-safe argument snapshot move plans", () => {
		const plan = (snapshotInstructions: Array<VmInstruction>, registerCount: number) =>
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
		const buf1 = serializeVmDefinition(definition, { debugInfo: true });
		const buf2 = serializeVmDefinition(deserializeVmDefinition(buf1), {
			debugInfo: true,
		});
		expect(Array.from(buf2)).toEqual(Array.from(buf1));
	});

	it("rejects stale wire versions", () => {
		const buffer = serializeVmDefinition(definition);
		new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).setUint32(
			4,
			WIRE_VERSION - 1,
			true,
		);
		expect(() => deserializeVmDefinition(buffer)).toThrow(
			`version ${WIRE_VERSION - 1}, expected ${WIRE_VERSION}`,
		);
	});

	it("drops debug tables when debugInfo is false", () => {
		const restored = deserializeVmDefinition(
			serializeVmDefinition(definition, { debugInfo: false }),
		);
		expect(restored.files).toEqual([]);
		expect(restored.sourcePositions).toEqual([]);
		for (const fn of restored.functions) {
			expect(fn.positions).toEqual([]);
			expect(fn.fileIndex).toBe(0);
		}
		// Non-debug payload survives intact.
		expect(restored.functions[0]!.instructions).toEqual(mainFn.instructions);
		expect(restored.bigintConstants).toEqual(definition.bigintConstants);
		expect(restored.stringConstants).toEqual(definition.stringConstants);
	});

	it("preserves astral code units and signed >64-bit bigints", () => {
		const restored = deserializeVmDefinition(serializeVmDefinition(definition));
		expect(restored.stringConstants[2]).toEqual([0xd83d, 0xde00]);
		expect(restored.bigintConstants[1]).toBe(-((1n << 100n) + 7n));
	});

	it("uses canonical u32 LEB128 at count boundaries", () => {
		for (const [count, encoding] of [
			[0, [0]],
			[127, [127]],
			[128, [0x80, 1]],
			[16_383, [0xff, 0x7f]],
			[16_384, [0x80, 0x80, 1]],
		] as const) {
			const probe: VmDefinition = {
				...definition,
				functions: [],
				functionCount: 0,
				stringConstants: [],
				bigintConstants: [],
				literalTemplateData: new Array<number>(count).fill(0xffffffff),
				files: [],
				sourcePositions: [],
				cjsModuleFunctionIndices: [],
			};
			const wire = serializeVmDefinition(probe, { debugInfo: false });
			// Fixed magic/version, one-byte flags/global/entry length, the entry bytes,
			// then one-byte string and bigint counts.
			const literalCountOffset =
				13 + new TextEncoder().encode(probe.entrypointPath).length;
			expect(
				Array.from(
					wire.subarray(literalCountOffset, literalCountOffset + encoding.length),
				),
			).toEqual(encoding);
			expect(deserializeVmDefinition(wire).literalTemplateData).toEqual(
				probe.literalTemplateData,
			);
		}
	});

	it("rejects truncated, overflowing, and non-canonical varints", () => {
		const wire = serializeVmDefinition(definition, { debugInfo: false });
		const replaceFlags = (bytes: Array<number>): Uint8Array =>
			Uint8Array.from([...wire.subarray(0, 8), ...bytes, ...wire.subarray(9)]);

		expect(() =>
			deserializeVmDefinition(Uint8Array.from([...wire.subarray(0, 8), 0x80])),
		).toThrow();
		expect(() =>
			deserializeVmDefinition(replaceFlags([0x80, 0x80, 0x80, 0x80, 0x10])),
		).toThrow(/invalid u32 varint/);
		expect(() => deserializeVmDefinition(replaceFlags([0x80, 0]))).toThrow(
			/non-canonical u32 varint/,
		);
	});

	it("rejects trailing data", () => {
		const wire = serializeVmDefinition(definition);
		expect(() => deserializeVmDefinition(Uint8Array.from([...wire, 0]))).toThrow(
			/trailing data/,
		);
	});

	it("rejects negative direct argument indices", () => {
		const probe: VmDefinition = {
			...definition,
			functions: [
				{
					...mainFn,
					argumentSnapshotCount: 1,
					instructions: [{ opcode: "LOAD_ARGUMENT", dst: 1, index: -1 }],
				},
			],
			functionCount: 1,
		};
		expect(() => serializeVmDefinition(probe)).toThrow(/negative argument index/);
	});

	it.each([
		[0, [], []],
		[65, new Array<number>(65).fill(0), new Array<number>(65).fill(0)],
		[2, [0], [0, 1]],
		[2, [0, 1], [0]],
	])(
		"rejects invalid shaped object operands",
		(count, keyStringIndices, valueRegisters) => {
			const probe: VmDefinition = {
				...definition,
				functions: [
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
				],
				functionCount: 1,
			};
			expect(() => serializeVmDefinition(probe)).toThrow(
				/invalid shaped object operands/,
			);
		},
	);

	it("drops the vestigial TRY_BEGIN.handlerIp (restored as 0)", () => {
		const probe: VmDefinition = {
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
			globalCount: 0,
			files: [],
			sourcePositions: [],
			cjsModuleFunctionIndices: [],
			hostInstalls: [],
		};
		const restored = deserializeVmDefinition(serializeVmDefinition(probe));
		expect(restored.functions[0]!.instructions[0]).toEqual({
			opcode: "TRY_BEGIN",
			handlerIp: 0,
		});
	});

	it("rejects a buffer with a bad magic", () => {
		const buf = serializeVmDefinition(definition);
		buf[0] = 0;
		expect(() => deserializeVmDefinition(buf)).toThrow(/bad magic/);
	});

	it("round-trips portable host install manifests", () => {
		const restored = deserializeVmDefinition(serializeVmDefinition(hostDefinition));
		expect(restored.hostInstalls).toEqual(hostDefinition.hostInstalls);
	});

	it("rejects string constants above the runtime UTF-16 limit", () => {
		const oversized: VmDefinition = {
			...definition,
			stringConstants: [new Array<number>(MAX_STRING_CODE_UNITS + 1)],
		};
		expect(() => serializeVmDefinition(oversized)).toThrow(
			/string constant has .* UTF-16 code units/,
		);
	});

	it("retains host installs in a stripped wire definition", () => {
		const restored = deserializeVmDefinition(
			serializeVmDefinition(hostDefinition, { debugInfo: false }),
		);
		expect(restored.hostInstalls).toEqual(hostDefinition.hostInstalls);
	});

	it("rejects a truncated host-install manifest", () => {
		const buffer = serializeVmDefinition(definition);
		buffer[buffer.byteLength - 1] = 1;
		expect(() => deserializeVmDefinition(buffer)).toThrow(/truncated|corrupt|read/);
	});

	it("round-trips an ordinary wire definition with an empty manifest", () => {
		const restored = deserializeVmDefinition(serializeVmDefinition(definition));
		expect(restored.hostInstalls).toEqual([]);
	});
});
