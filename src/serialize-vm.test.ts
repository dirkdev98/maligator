import { describe, expect, it } from "vitest";
import type { VmDefinition, VmFunction, VmInstruction } from "./lower-vm.ts";
import {
	deserializeVmDefinition,
	MAX_STRING_CODE_UNITS,
	serializeVmDefinition,
	WIRE_OPCODES,
	WIRE_VERSION,
} from "./serialize-vm.ts";

// A definition exercising the tricky encodings: variable-length operand arrays
// (CALL / CREATE_OBJECT_SHAPED / CREATE_MODULE_NAMESPACE / CREATE_TEMPLATE_OBJECT /
// COPY_DATA_PROPERTIES), the f64 / boolean / enum / u16-intrinsic operands,
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
	{ opcode: "LOAD_PROPERTY_STATIC", dst: 7, object: 10, stringIndex: 1 },
	{ opcode: "STORE_PROPERTY_STATIC", object: 10, value: 7, stringIndex: 1 },
	{ opcode: "BINARY", dst: 8, left: 0, right: 1, operator: ">>>" },
	{ opcode: "UNARY", dst: 9, src: 8, operator: "typeof" },
	{ opcode: "TRY_BEGIN", handlerIp: 0 },
	{
		opcode: "CREATE_OBJECT_SHAPED",
		dst: 10,
		count: 2,
		keyStringIndices: [0, 1],
		valueRegisters: [3, 7],
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
	{ opcode: "TRY_END" },
	{ opcode: "ENV_PUSH", scopeId: -2, slotCount: 1 },
	{ opcode: "ENV_POP" },
	{ opcode: "RETURN", value: 11 },
];

const mainFn: VmFunction = {
	nameStringIndex: 0,
	isGenerator: false,
	isAsync: false,
	parameterCount: 1,
	length: 1,
	registerCount: 15,
	capturedCount: 0,
	strict: true,
	needsArguments: true,
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
	length: 0,
	registerCount: 3,
	capturedCount: 1,
	strict: true,
	needsArguments: true,
	isDerivedConstructor: true,
	isClassConstructor: true,
	hasPrototype: false,
	instructions: [
		{ opcode: "ASYNC_START" },
		{ opcode: "AWAIT", awaitedSrc: 0, valueDst: 1, modeDst: 2 },
		{ opcode: "YIELD", yieldedSrc: 1, valueDst: 0, modeDst: 2 },
		{ opcode: "RETURN", value: 0 },
	],
	handlers: [],
	fileIndex: 1,
	positions: [0, 0, 0, 0],
};

const definition: VmDefinition = {
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
	});

	it("round-trips a definition with debug info", () => {
		const restored = deserializeVmDefinition(
			serializeVmDefinition(definition, { debugInfo: true }),
		);
		expect(restored).toEqual(definition);
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
			// Fixed magic/version, then one-byte flags/global/string-count/bigint-count.
			expect(Array.from(wire.subarray(12, 12 + encoding.length))).toEqual(encoding);
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
					instructions: [{ opcode: "LOAD_ARGUMENT", dst: 0, index: -1 }],
				},
			],
			functionCount: 1,
		};
		expect(() => serializeVmDefinition(probe)).toThrow(/negative argument index/);
	});

	it.each([
		[0, [], []],
		[33, new Array<number>(33).fill(0), new Array<number>(33).fill(0)],
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

	it("rejects definitions with host installs", () => {
		expect(() => serializeVmDefinition(hostDefinition)).toThrow(
			/host installs are not supported in portable wire definitions/,
		);
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

	it("rejects host installs before producing a stripped wire definition", () => {
		expect(() => serializeVmDefinition(hostDefinition, { debugInfo: false })).toThrow(
			/host installs are not supported in portable wire definitions/,
		);
	});

	it("rejects a wire buffer with a nonzero host-install count", () => {
		const buffer = serializeVmDefinition(definition);
		buffer[buffer.byteLength - 1] = 1;
		expect(() => deserializeVmDefinition(buffer)).toThrow(
			/host installs are not supported in portable wire definitions/,
		);
	});

	it("round-trips an ordinary wire definition with an empty manifest", () => {
		const restored = deserializeVmDefinition(serializeVmDefinition(definition));
		expect(restored.hostInstalls).toEqual([]);
	});
});
