import { buildArgumentSnapshotPlan, compressPositions } from "./lower-vm.ts";
import type { VmDefinition, VmFunction, VmInstruction } from "./lower-vm.ts";

/**
 * Sequential binary wire format for a {@link VmDefinition}, consumed at
 * runtime by the C loader `mal_vm_load_definition` (runtime/src/vm_load.c). It is
 * the same data `emit-vm.ts` bakes into C literals, but as a buffer the running
 * VM can ingest without a C compile — the foundation of runtime `eval` and a
 * future bytecode cache.
 *
 * The codec is sequential: the reader walks sections in the exact order the
 * writer wrote them, so no in-buffer offsets are needed. The opcode / operator /
 * intrinsic tag orderings below are the cross-language contract — the C loader
 * mirrors them. Existing tags and operand layouts are immutable; new opcodes are
 * appended so older inputs remain readable. WIRE_VERSION is bumped only for
 * an incompatible layout change, which deliberately rejects stale buffers.
 */

export const WIRE_MAGIC = 0x574c414d; // "MALW" little-endian
// Bumped to 15 for mapped Arguments function metadata.
export const WIRE_VERSION = 15;
// Keep in sync with runtime/src/heap_string.h.
export const MAX_STRING_CODE_UNITS = 16 * 1024 * 1024;

/**
 * Canonical opcode order = the wire tag (a u8 index into this array). The C
 * loader's `MalWireOp` enum mirrors this order exactly; keep them in lockstep.
 */
export const WIRE_OPCODES = [
	"MOVE",
	"RETURN",
	"JUMP_IF",
	"JUMP",
	"CREATE_NUMBER",
	"CREATE_F64",
	"CREATE_BOOLEAN",
	"CREATE_STRING",
	"CREATE_BIGINT",
	"CREATE_OBJECT",
	"CREATE_OBJECT_SHAPED",
	"CREATE_ARRAY",
	"CREATE_MODULE_NAMESPACE",
	"CREATE_TEMPLATE_OBJECT",
	"CREATE_UNDEFINED",
	"CREATE_EMPTY",
	"CREATE_NULL",
	"CREATE_FUNCTION",
	"CREATE_ARGUMENTS_OBJECT",
	"LOAD_THIS",
	"LOAD_NEW_TARGET",
	"CALL",
	"CONSTRUCT",
	"THROW",
	"CATCH",
	"TRY_BEGIN",
	"TRY_END",
	"GENERATOR_START",
	"ASYNC_START",
	"YIELD",
	"AWAIT",
	"LOAD_INTRINSIC",
	"LOAD_CAPTURED",
	"LOAD_GLOBAL",
	"STORE_CAPTURED",
	"ENV_PUSH",
	"ENV_COPY",
	"ENV_POP",
	"STORE_GLOBAL",
	"LOAD_PROPERTY",
	"STORE_PROPERTY",
	"TO_PROPERTY_KEY",
	"STORE_SUPER_PROPERTY",
	"LOAD_PROTOTYPE",
	"GET_ITERATOR",
	"GET_ASYNC_ITERATOR",
	"ITERATOR_NEXT",
	"ITERATOR_STEP",
	"ITERATOR_CLOSE",
	"FOR_IN_KEYS",
	"CALL_SPREAD",
	"CONSTRUCT_SPREAD",
	"CONSTRUCT_SUPER",
	"MERGE_DATA_PROPERTIES",
	"DELETE_PROPERTY",
	"DEFINE_ACCESSOR",
	"DEFINE_PROPERTY",
	"CREATE_PRIVATE_NAME",
	"DEFINE_PRIVATE",
	"LOAD_PRIVATE",
	"STORE_PRIVATE",
	"HAS_PRIVATE",
	"SET_PROTOTYPE",
	"LOAD_UNDECLARED",
	"LOAD_GLOBAL_PROPERTY",
	"STORE_GLOBAL_PROPERTY",
	"THROW_IF_TDZ",
	"WITH_ENTER",
	"WITH_EXIT",
	"WITH_GET",
	"WITH_SET",
	"IS_EMPTY",
	"REQUIRE_COERCIBLE",
	"CREATE_REST_ARGUMENTS",
	"ARRAY_REST",
	"COPY_DATA_PROPERTIES",
	"BINARY",
	"UNARY",
	// Appended last to preserve existing wire tags; mirrored by the trailing
	// WIRE_WITH_RESOLVE_BASE / WIRE_SET_FUNCTION_NAME in the C wire_opcodes enum
	// (vm_load.c). APPEND-ONLY.
	"WITH_RESOLVE_BASE",
	"SET_FUNCTION_NAME",
	"CHECK_SUPER_CLASS",
	"LOAD_CALLEE",
	"GUARD_FUNCTION_INDEX",
	"LOAD_SUPER_PROPERTY",
	"INSTANTIATE_LITERAL_TEMPLATE",
	"LOAD_ARGUMENT_COUNT",
	"LOAD_ARGUMENT",
	"LOAD_PROPERTY_STATIC",
	"STORE_PROPERTY_STATIC",
	"INIT_GLOBAL_VARS",
	"CREATE_PRIVATE_NAMES",
	"INIT_PRIVATE_FIELDS",
	"TYPEOF_COMPARE",
	"TERMINAL_YIELD",
	"CONSTRUCT_SUPER_EXPLICIT",
	"SET_THIS",
	"LOAD_STATIC_ARGUMENT",
] as const;

const OPCODE_TAG = new Map<string, number>(WIRE_OPCODES.map((name, i) => [name, i]));

/** Binary-operator wire order; mirrored by the C `wire_binops[]` table. */
export const WIRE_BINOPS = [
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
	"in",
	"instanceof",
] as const;
const BINOP_TAG = new Map<string, number>(WIRE_BINOPS.map((op, i) => [op, i]));

/** Unary-operator wire order; mirrored by the C `wire_unops[]` table. */
export const WIRE_UNOPS = [
	"!",
	"-",
	"+",
	"~",
	"typeof",
	"tonumeric",
	"increment",
	"decrement",
] as const;
const UNOP_TAG = new Map<string, number>(WIRE_UNOPS.map((op, i) => [op, i]));

/** Canonical typeof-result order; mirrored by `wire_typeof_results` in vm_load.c. */
export const WIRE_TYPEOF_RESULTS = [
	"undefined",
	"object",
	"boolean",
	"number",
	"string",
	"symbol",
	"bigint",
	"function",
] as const;
const TYPEOF_RESULT_TAG = new Map<string, number>(
	WIRE_TYPEOF_RESULTS.map((result, i) => [result, i]),
);

/**
 * Intrinsic wire order = a u16 index into this array; the C `wire_intrinsics[]`
 * table maps each index back to its `MAL_INTRINSIC_*` constant in the same order.
 * Mirrors `emitIntrinsic` in emit-vm.ts.
 */
export const WIRE_INTRINSICS = [
	"Object",
	"Array",
	"Function",
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"AggregateError",
	"String",
	"Number",
	"Boolean",
	"Symbol",
	"BigInt",
	"ArrayBuffer",
	"SharedArrayBuffer",
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
	"BigInt64Array",
	"BigUint64Array",
	"DataView",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"WeakRef",
	"FinalizationRegistry",
	"Promise",
	"Date",
	"RegExp",
	"Intl",
	"Iterator",
	"AsyncIterator",
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"decodeURI",
	"decodeURIComponent",
	"encodeURI",
	"encodeURIComponent",
	"Math",
	"JSON",
	"Reflect",
	"Proxy",
	"console",
	"globalThis",
	"NaN",
	"Infinity",
	"__cjs_require",
	"__arrayIterationEligible",
	"__arrayFlatMapAppend",
	// Appended last so existing wire tags keep their indices.
	"eval",
	"__directEval",
	"Atomics",
	"__dynamicImport",
] as const;
const INTRINSIC_TAG = new Map<string, number>(
	WIRE_INTRINSICS.map((name, i) => [name, i]),
);

const FLAG_HAS_DEBUG = 1;

/** Growable little-endian buffer writer. */
class Writer {
	private buf = new ArrayBuffer(1024);
	private view = new DataView(this.buf);
	private bytes = new Uint8Array(this.buf);
	private pos = 0;

	private ensure(extra: number): void {
		if (this.pos + extra <= this.buf.byteLength) {
			return;
		}
		let size = this.buf.byteLength * 2;
		while (size < this.pos + extra) {
			size *= 2;
		}
		const next = new ArrayBuffer(size);
		new Uint8Array(next).set(this.bytes.subarray(0, this.pos));
		this.buf = next;
		this.view = new DataView(next);
		this.bytes = new Uint8Array(next);
	}

	u8(value: number): void {
		this.ensure(1);
		this.view.setUint8(this.pos, value);
		this.pos += 1;
	}
	u16(value: number): void {
		this.ensure(2);
		this.view.setUint16(this.pos, value, true);
		this.pos += 2;
	}
	fixedU32(value: number): void {
		this.ensure(4);
		this.view.setUint32(this.pos, value, true);
		this.pos += 4;
	}
	u32(value: number): void {
		let remaining = value < 0 ? value + 0x100000000 : value;
		for (let byteIndex = 0; byteIndex < 5; ++byteIndex) {
			const byte = remaining % 0x80;
			remaining = (remaining - byte) / 0x80;
			this.u8(byte | (remaining > 0 ? 0x80 : 0));
			if (remaining === 0) {
				return;
			}
		}
		throw new RangeError("serialize-vm: u32 out of range");
	}
	i32(value: number): void {
		const signed = value | 0;
		this.u32(signed < 0 ? -2 * signed - 1 : 2 * signed);
	}
	f64(value: number): void {
		this.ensure(8);
		this.view.setFloat64(this.pos, value, true);
		this.pos += 8;
	}
	u64(value: bigint): void {
		this.ensure(8);
		this.view.setBigUint64(this.pos, value & ((1n << 64n) - 1n), true);
		this.pos += 8;
	}
	/** Length-prefixed i32 array. */
	i32Array(values: Array<number>): void {
		this.u32(values.length);
		for (const v of values) {
			this.i32(v);
		}
	}

	finish(): Uint8Array {
		return this.bytes.slice(0, this.pos);
	}
}

/** Sequential buffer reader (the inverse of {@link Writer}). */
class Reader {
	private view: DataView;
	private pos = 0;
	constructor(bytes: Uint8Array) {
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
	u8(): number {
		const v = this.view.getUint8(this.pos);
		this.pos += 1;
		return v;
	}
	u16(): number {
		const v = this.view.getUint16(this.pos, true);
		this.pos += 2;
		return v;
	}
	fixedU32(): number {
		const v = this.view.getUint32(this.pos, true);
		this.pos += 4;
		return v;
	}
	u32(): number {
		let value = 0;
		for (let shift = 0; shift <= 28; shift += 7) {
			const byte = this.u8();
			if (shift === 28 && (byte & 0xf0) !== 0) {
				throw new RangeError("serialize-vm: invalid u32 varint");
			}
			value += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) {
				if (shift > 0 && (byte & 0x7f) === 0) {
					throw new RangeError("serialize-vm: non-canonical u32 varint");
				}
				return value >>> 0;
			}
		}
		throw new RangeError("serialize-vm: invalid u32 varint");
	}
	i32(): number {
		const value = this.u32();
		return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
	}
	f64(): number {
		const v = this.view.getFloat64(this.pos, true);
		this.pos += 8;
		return v;
	}
	u64(): bigint {
		const v = this.view.getBigUint64(this.pos, true);
		this.pos += 8;
		return v;
	}
	i32Array(): Array<number> {
		const n = this.count(1);
		const out = new Array<number>(n);
		for (let i = 0; i < n; ++i) {
			out[i] = this.i32();
		}
		return out;
	}
	count(minimumBytesPerItem: number): number {
		const count = this.u32();
		if (
			count > 0x7fffffff ||
			count > Math.floor(this.remaining() / minimumBytesPerItem)
		) {
			throw new RangeError("serialize-vm: truncated or corrupt buffer");
		}
		return count;
	}
	remaining(): number {
		return this.view.byteLength - this.pos;
	}
}

// Manual UTF-8 codec rather than TextEncoder/TextDecoder: this module is part
// of the self-hostable compiler cone, and MalVm provides no Web/Node globals.
function utf8Encode(text: string): Array<number> {
	const out: Array<number> = [];
	for (let i = 0; i < text.length; i++) {
		let code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
			const low = text.charCodeAt(i + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
				i++;
			}
		}
		if (code < 0x80) {
			out.push(code);
		} else if (code < 0x800) {
			out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		} else if (code < 0x10000) {
			out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		} else {
			out.push(
				0xf0 | (code >> 18),
				0x80 | ((code >> 12) & 0x3f),
				0x80 | ((code >> 6) & 0x3f),
				0x80 | (code & 0x3f),
			);
		}
	}
	return out;
}

function utf8Decode(bytes: Array<number>): string {
	let out = "";
	for (let i = 0; i < bytes.length; ) {
		const b0 = bytes[i++]!;
		let code: number;
		if (b0 < 0x80) {
			code = b0;
		} else if (b0 < 0xe0) {
			code = ((b0 & 0x1f) << 6) | (bytes[i++]! & 0x3f);
		} else if (b0 < 0xf0) {
			code = ((b0 & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
		} else {
			code =
				((b0 & 0x07) << 18) |
				((bytes[i++]! & 0x3f) << 12) |
				((bytes[i++]! & 0x3f) << 6) |
				(bytes[i++]! & 0x3f);
		}
		if (code >= 0x10000) {
			code -= 0x10000;
			out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
		} else {
			out += String.fromCharCode(code);
		}
	}
	return out;
}

/**
 * Serialize a lowered definition to the binary wire format. With `debugInfo`
 * false the file/source-position/per-function position tables are dropped
 * (matching emit-vm's stripped batch path), yielding a smaller buffer whose
 * traces carry function names only.
 */
export function serializeVmDefinition(
	def: VmDefinition,
	options: { debugInfo?: boolean } = {},
): Uint8Array {
	if (def.hostInstalls.length > 0) {
		throw new Error(
			"serialize-vm: host installs are not supported in portable wire definitions",
		);
	}
	const debug = options.debugInfo !== false;
	const w = new Writer();

	w.fixedU32(WIRE_MAGIC);
	w.fixedU32(WIRE_VERSION);
	w.u32(debug ? FLAG_HAS_DEBUG : 0);
	w.u32(def.globalCount);

	// Strings: each is a length-prefixed UTF-16 code-unit run.
	w.u32(def.stringConstants.length);
	for (const units of def.stringConstants) {
		if (units.length > MAX_STRING_CODE_UNITS) {
			throw new RangeError(
				`serialize-vm: string constant has ${units.length} UTF-16 code units; maximum is ${MAX_STRING_CODE_UNITS}`,
			);
		}
		w.u32(units.length);
		for (const unit of units) {
			w.u16(unit);
		}
	}

	// BigInts: 128-bit two's-complement, low u64 then high u64 (matches the
	// runtime's hi/lo split in emitBigintValue).
	w.u32(def.bigintConstants.length);
	const mask = (1n << 64n) - 1n;
	for (const value of def.bigintConstants) {
		w.u64(value & mask);
		w.u64((value >> 64n) & mask);
	}

	// Packed static-data literal templates. Tags and operands are all u32 words.
	w.u32(def.literalTemplateData.length);
	for (const word of def.literalTemplateData) w.fixedU32(word);

	w.i32Array(def.cjsModuleFunctionIndices);

	// Functions.
	w.u32(def.functions.length);
	for (const fn of def.functions) {
		writeFunction(w, fn, debug);
	}

	// Debug-info definition tables.
	if (debug) {
		w.u32(def.files.length);
		for (const file of def.files) {
			const enc = utf8Encode(file);
			w.u32(enc.length);
			for (const b of enc) {
				w.u8(b);
			}
		}
		w.u32(def.sourcePositions.length);
		for (const pos of def.sourcePositions) {
			w.i32(pos.line);
			w.i32(pos.column);
			w.i32(pos.inlinedFunctionIndex ?? -1);
			w.i32(pos.callerPosId ?? -1);
		}
	} else {
		w.u32(0); // files
		w.u32(0); // source positions
	}

	// The wire reserves this section for host installs, but portable definitions
	// cannot resolve native installer pointers without a registry.
	w.u32(0);

	return w.finish();
}

function writeFunction(w: Writer, fn: VmFunction, debug: boolean): void {
	validateArgumentSnapshotPrefix(fn);
	validateMappedArguments(fn);
	validatePropertyIcIndices(fn);
	w.i32(fn.nameStringIndex);
	w.u8(fn.isAsync && fn.isGenerator ? 3 : fn.isAsync ? 2 : fn.isGenerator ? 1 : 0);
	w.u8(fn.strict ? 1 : 0);
	w.u8(fn.needsArguments ? 1 : 0);
	w.u8(fn.isDerivedConstructor ? 1 : 0);
	w.u8(fn.isClassConstructor ? 1 : 0);
	w.u8(fn.hasPrototype ? 1 : 0);
	w.u8(fn.mappedArguments ? 1 : 0);
	w.u32(fn.argumentSnapshotCount);
	w.u32(fn.argumentSnapshotPlan.length);
	for (const move of fn.argumentSnapshotPlan) {
		w.i32(move.destination);
		w.i32(move.source);
	}
	w.u32(fn.mappedArgumentSlots.length);
	for (const slot of fn.mappedArgumentSlots) w.i32(slot);
	w.i32(fn.parameterCount);
	w.i32(fn.length);
	w.i32(fn.registerCount);
	w.i32(fn.capturedCount);
	w.i32(debug ? fn.fileIndex : 0);

	w.u32(fn.instructions.length);
	for (const instruction of fn.instructions) {
		writeInstruction(w, instruction);
	}

	w.u32(fn.handlers.length);
	for (const handler of fn.handlers) {
		w.i32(handler.startIp);
		w.i32(handler.endIp);
		w.i32(handler.handlerIp);
	}

	// Position table: run-length compressed (start_ip, pos_id), as MalLineEntry.
	const runs = debug ? compressPositions(fn.positions) : [];
	w.u32(runs.length);
	for (const run of runs) {
		w.i32(run.startIp);
		w.i32(run.posId);
	}
}

function validateArgumentSnapshotPrefix(fn: VmFunction): void {
	let expected;
	try {
		expected = buildArgumentSnapshotPlan(fn);
	} catch (error) {
		throw new RangeError(
			`serialize-vm: ${error instanceof Error ? error.message : "invalid argument snapshots"}`,
		);
	}
	if (
		expected.length !== fn.argumentSnapshotPlan.length ||
		expected.some(
			(move, i) =>
				move.destination !== fn.argumentSnapshotPlan[i]?.destination ||
				move.source !== fn.argumentSnapshotPlan[i]?.source,
		)
	) {
		throw new RangeError("serialize-vm: argument snapshot plan mismatch");
	}
}

function validateMappedArguments(fn: VmFunction): void {
	if (
		fn.mappedArgumentSlots.length > fn.parameterCount ||
		(!fn.mappedArguments && fn.mappedArgumentSlots.length !== 0) ||
		(fn.mappedArguments && fn.strict) ||
		fn.mappedArgumentSlots.some((slot) => slot < -1 || slot >= fn.capturedCount)
	) {
		throw new RangeError("serialize-vm: invalid mapped arguments metadata");
	}
}

function validatePropertyIcIndices(fn: VmFunction): void {
	let expected = 0;
	for (const instruction of fn.instructions) {
		switch (instruction.opcode) {
			case "LOAD_PROPERTY":
			case "LOAD_PROPERTY_STATIC":
			case "STORE_PROPERTY":
			case "STORE_PROPERTY_STATIC":
				if (instruction.icIndex !== expected) {
					throw new RangeError(
						`serialize-vm: property IC index ${instruction.icIndex}, expected ${expected}`,
					);
				}
				expected++;
				break;
		}
	}
}

function opcodeTag(opcode: string): number {
	const tag = OPCODE_TAG.get(opcode);
	if (tag === undefined) {
		throw new Error(`serialize-vm: unknown opcode ${opcode}`);
	}
	return tag;
}

function writeInstruction(w: Writer, i: VmInstruction): void {
	w.u8(opcodeTag(i.opcode));
	switch (i.opcode) {
		case "MOVE":
			w.i32(i.dst);
			w.i32(i.src);
			return;
		case "RETURN":
		case "THROW":
			w.i32(i.value);
			return;
		case "JUMP_IF":
			w.i32(i.cond);
			w.i32(i.targetIp);
			return;
		case "JUMP":
			w.i32(i.targetIp);
			return;
		case "CREATE_NUMBER":
			w.i32(i.dst);
			w.i32(i.value);
			return;
		case "CREATE_F64":
			w.i32(i.dst);
			w.f64(i.value);
			return;
		case "CREATE_BOOLEAN":
			w.i32(i.dst);
			w.u8(i.value ? 1 : 0);
			return;
		case "CREATE_STRING":
			w.i32(i.dst);
			w.i32(i.stringIndex);
			return;
		case "CREATE_BIGINT":
			w.i32(i.dst);
			w.i32(i.bigintIndex);
			return;
		case "CREATE_OBJECT":
		case "CREATE_UNDEFINED":
		case "CREATE_EMPTY":
		case "CREATE_NULL":
		case "CREATE_ARGUMENTS_OBJECT":
		case "LOAD_ARGUMENT_COUNT":
		case "LOAD_THIS":
		case "LOAD_NEW_TARGET":
		case "LOAD_CALLEE":
		case "CATCH":
		case "CREATE_PRIVATE_NAME":
			w.i32(i.dst);
			return;
		case "CREATE_PRIVATE_NAMES":
			if (i.capturedIndices.length === 0) {
				throw new RangeError("serialize-vm: empty private-name batch");
			}
			w.i32(i.ownerFunctionIndex);
			w.i32(i.capturedIndices.length);
			w.i32Array(i.capturedIndices);
			return;
		case "LOAD_ARGUMENT":
			if (i.index < 0) throw new RangeError("serialize-vm: negative argument index");
			w.i32(i.dst);
			w.i32(i.index);
			return;
		case "LOAD_STATIC_ARGUMENT":
			if (i.index < 0) throw new RangeError("serialize-vm: negative argument index");
			w.i32(i.dst);
			w.i32(i.direct);
			w.i32(i.fallback);
			w.i32(i.index);
			return;
		case "CREATE_OBJECT_SHAPED":
			if (
				i.count < 1 ||
				i.count > 32 ||
				i.keyStringIndices.length !== i.count ||
				i.valueRegisters.length !== i.count
			) {
				throw new RangeError("serialize-vm: invalid shaped object operands");
			}
			w.i32(i.dst);
			w.i32(i.count);
			w.i32Array(i.keyStringIndices);
			w.i32Array(i.valueRegisters);
			return;
		case "CREATE_ARRAY":
			w.i32(i.dst);
			w.i32(i.length);
			return;
		case "INSTANTIATE_LITERAL_TEMPLATE":
			w.i32(i.dst);
			w.i32(i.templateOffset);
			return;
		case "CREATE_MODULE_NAMESPACE":
			w.i32(i.dst);
			w.i32Array(i.nameIndices);
			w.i32Array(i.slots);
			return;
		case "CREATE_TEMPLATE_OBJECT":
			w.i32(i.dst);
			w.i32(i.cacheSlot);
			w.i32Array(i.cookedIndices);
			w.i32Array(i.rawIndices);
			return;
		case "CREATE_FUNCTION":
			w.i32(i.dst);
			w.i32(i.functionIndex);
			return;
		case "CALL":
			w.i32(i.dst);
			w.i32(i.callee);
			w.i32(i.thisValue);
			w.i32(i.argumentCount);
			w.i32Array(i.arguments);
			return;
		case "CONSTRUCT":
			w.i32(i.dst);
			w.i32(i.callee);
			w.i32(i.argumentCount);
			w.i32Array(i.arguments);
			return;
		// TRY_BEGIN.handlerIp is vestigial post-lowering (ranges live in the
		// handler table; the C MalInstruction carries no operand), so it is
		// intentionally dropped — deserialize restores it as 0.
		case "TRY_BEGIN":
		case "TRY_END":
		case "GENERATOR_START":
		case "ASYNC_START":
		case "WITH_EXIT":
		case "ENV_POP":
			return;
		case "YIELD":
			w.i32(i.yieldedSrc);
			w.i32(i.valueDst);
			w.i32(i.modeDst);
			return;
		case "TERMINAL_YIELD":
			w.i32(i.yieldedSrc);
			return;
		case "AWAIT":
			w.i32(i.awaitedSrc);
			w.i32(i.valueDst);
			w.i32(i.modeDst);
			return;
		case "LOAD_INTRINSIC": {
			const tag = INTRINSIC_TAG.get(i.intrinsic);
			if (tag === undefined) {
				throw new Error(`serialize-vm: unknown intrinsic ${i.intrinsic}`);
			}
			w.i32(i.dst);
			w.u16(tag);
			return;
		}
		case "LOAD_CAPTURED":
			w.i32(i.dst);
			w.i32(i.ownerFunctionIndex);
			w.i32(i.index);
			return;
		case "GUARD_FUNCTION_INDEX":
			w.i32(i.dst);
			w.i32(i.callee);
			w.i32(i.functionIndex);
			return;
		case "STORE_CAPTURED":
			w.i32(i.src);
			w.i32(i.ownerFunctionIndex);
			w.i32(i.index);
			return;
		case "ENV_PUSH":
		case "ENV_COPY":
			w.i32(i.scopeId);
			w.i32(i.slotCount);
			return;
		case "LOAD_GLOBAL":
			w.i32(i.dst);
			w.i32(i.index);
			return;
		case "STORE_GLOBAL":
			w.i32(i.src);
			w.i32(i.index);
			return;
		case "LOAD_PROPERTY":
		case "DELETE_PROPERTY":
		case "TO_PROPERTY_KEY":
		case "LOAD_PRIVATE":
		case "HAS_PRIVATE":
			w.i32(i.dst);
			w.i32(i.object);
			w.i32(i.key);
			return;
		case "LOAD_PROPERTY_STATIC":
			w.i32(i.dst);
			w.i32(i.object);
			w.i32(i.stringIndex);
			return;
		case "STORE_PROPERTY":
		case "DEFINE_PRIVATE":
		case "STORE_PRIVATE":
			w.i32(i.object);
			w.i32(i.key);
			w.i32(i.value);
			return;
		case "INIT_PRIVATE_FIELDS":
			if (i.keyRegisters.length === 0) {
				throw new RangeError("serialize-vm: empty private-field batch");
			}
			w.i32(i.object);
			w.i32(i.keyRegisters.length);
			w.i32Array(i.keyRegisters);
			return;
		case "STORE_PROPERTY_STATIC":
			w.i32(i.object);
			w.i32(i.value);
			w.i32(i.stringIndex);
			return;
		case "STORE_SUPER_PROPERTY":
			w.i32(i.object);
			w.i32(i.key);
			w.i32(i.value);
			w.i32(i.receiver);
			return;
		case "LOAD_SUPER_PROPERTY":
			w.i32(i.dst);
			w.i32(i.object);
			w.i32(i.key);
			w.i32(i.receiver);
			return;
		case "LOAD_PROTOTYPE":
			w.i32(i.dst);
			w.i32(i.object);
			return;
		case "GET_ITERATOR":
		case "GET_ASYNC_ITERATOR":
			w.i32(i.iteratorDst);
			w.i32(i.nextDst);
			w.i32(i.source);
			return;
		case "ITERATOR_NEXT":
			w.i32(i.resultDst);
			w.i32(i.iterator);
			w.i32(i.next);
			return;
		case "ITERATOR_STEP":
			w.i32(i.valueDst);
			w.i32(i.doneDst);
			w.i32(i.iterator);
			w.i32(i.next);
			return;
		case "ITERATOR_CLOSE":
			w.i32(i.iterator);
			w.u8(i.normal ? 1 : 0);
			return;
		case "FOR_IN_KEYS":
			w.i32(i.dst);
			w.i32(i.source);
			return;
		case "CALL_SPREAD":
			w.i32(i.dst);
			w.i32(i.callee);
			w.i32(i.thisValue);
			w.i32(i.argumentsArray);
			return;
		case "CONSTRUCT_SPREAD":
			w.i32(i.dst);
			w.i32(i.callee);
			w.i32(i.argumentsArray);
			return;
		case "CONSTRUCT_SUPER":
			w.i32(i.dst);
			w.i32(i.parent);
			w.i32(i.argumentsArray);
			return;
		case "CONSTRUCT_SUPER_EXPLICIT":
			w.i32(i.dst);
			w.i32(i.parent);
			w.i32(i.argumentsArray);
			w.i32(i.newTarget);
			return;
		case "SET_THIS":
			w.i32(i.value);
			return;
		case "MERGE_DATA_PROPERTIES":
			w.i32(i.target);
			w.i32(i.src);
			return;
		case "DEFINE_ACCESSOR":
			w.i32(i.object);
			w.i32(i.key);
			w.i32(i.accessor);
			w.u8(i.isSetter ? 1 : 0);
			w.u8(i.enumerable ? 1 : 0);
			return;
		case "DEFINE_PROPERTY":
			w.i32(i.object);
			w.i32(i.key);
			w.i32(i.value);
			w.u8(i.enumerable ? 1 : 0);
			w.u8(i.writable ? 1 : 0);
			w.u8(i.configurable ? 1 : 0);
			return;
		case "SET_FUNCTION_NAME":
			w.i32(i.func);
			w.i32(i.key);
			w.u8(i.prefix);
			return;
		case "SET_PROTOTYPE":
			w.i32(i.object);
			w.i32(i.prototype);
			w.u8(i.literal ? 1 : 0);
			return;
		case "LOAD_UNDECLARED":
		case "LOAD_GLOBAL_PROPERTY":
		case "WITH_GET":
		case "WITH_RESOLVE_BASE":
			w.i32(i.dst);
			w.i32(i.nameStringIndex);
			return;
		case "STORE_GLOBAL_PROPERTY":
			w.i32(i.src);
			w.i32(i.nameStringIndex);
			w.u8(i.declaration ? 1 : 0);
			w.u8(i.declarationConfigurable ? 1 : 0);
			return;
		case "INIT_GLOBAL_VARS":
			if (i.nameStringIndices.length === 0) {
				throw new RangeError("serialize-vm: empty global-var initialization batch");
			}
			w.i32(i.nameStringIndices.length);
			w.i32Array(i.nameStringIndices);
			w.u8(i.declarationConfigurable ? 1 : 0);
			return;
		case "THROW_IF_TDZ":
			w.i32(i.src);
			w.i32(i.nameStringIndex);
			return;
		case "WITH_ENTER":
			w.i32(i.object);
			return;
		case "WITH_SET":
			w.i32(i.found);
			w.i32(i.value);
			w.i32(i.nameStringIndex);
			return;
		case "IS_EMPTY":
			w.i32(i.dst);
			w.i32(i.src);
			return;
		case "REQUIRE_COERCIBLE":
			w.i32(i.src);
			return;
		case "CHECK_SUPER_CLASS":
			w.i32(i.parent);
			return;
		case "CREATE_REST_ARGUMENTS":
			w.i32(i.dst);
			w.i32(i.startIndex);
			return;
		case "ARRAY_REST":
			w.i32(i.dst);
			w.i32(i.src);
			w.i32(i.startIndex);
			return;
		case "COPY_DATA_PROPERTIES":
			w.i32(i.dst);
			w.i32(i.src);
			w.i32(i.excludedCount);
			w.i32Array(i.excluded);
			return;
		case "BINARY": {
			const tag = BINOP_TAG.get(i.operator);
			if (tag === undefined) {
				throw new Error(`serialize-vm: unknown binary operator ${i.operator}`);
			}
			w.i32(i.dst);
			w.i32(i.left);
			w.i32(i.right);
			w.u8(tag);
			return;
		}
		case "UNARY": {
			const tag = UNOP_TAG.get(i.operator);
			if (tag === undefined) {
				throw new Error(`serialize-vm: unknown unary operator ${i.operator}`);
			}
			w.i32(i.dst);
			w.i32(i.src);
			w.u8(tag);
			return;
		}
		case "TYPEOF_COMPARE": {
			const tag = TYPEOF_RESULT_TAG.get(i.expected);
			if (tag === undefined) {
				throw new Error(`serialize-vm: unknown typeof result ${i.expected}`);
			}
			w.i32(i.dst);
			w.i32(i.src);
			w.u8(tag);
			w.u8(i.negated ? 1 : 0);
			return;
		}
	}
	throw new Error(`serialize-vm: unhandled opcode ${(i as { opcode: string }).opcode}`);
}

/**
 * Read a buffer produced by {@link serializeVmDefinition} back into a
 * {@link VmDefinition}. Used by the round-trip test and as the executable
 * reference for the C loader. The only intentional lossy point is
 * `TRY_BEGIN.handlerIp` (restored as 0); a stripped (debug-off) buffer yields
 * empty file/sourcePosition tables and empty per-function `positions`.
 */
export function deserializeVmDefinition(bytes: Uint8Array): VmDefinition {
	const r = new Reader(bytes);
	const magic = r.fixedU32();
	if (magic !== WIRE_MAGIC) {
		throw new Error(`serialize-vm: bad magic 0x${magic.toString(16)}`);
	}
	const version = r.fixedU32();
	if (version !== WIRE_VERSION) {
		throw new Error(`serialize-vm: version ${version}, expected ${WIRE_VERSION}`);
	}
	const debug = (r.u32() & FLAG_HAS_DEBUG) !== 0;
	const globalCount = r.u32();

	const stringCount = r.count(1);
	const stringConstants: Array<Array<number>> = [];
	for (let s = 0; s < stringCount; ++s) {
		const len = r.count(2);
		if (len > MAX_STRING_CODE_UNITS) {
			throw new RangeError(
				`serialize-vm: string constant has ${len} UTF-16 code units; maximum is ${MAX_STRING_CODE_UNITS}`,
			);
		}
		const units = new Array<number>(len);
		for (let u = 0; u < len; ++u) {
			units[u] = r.u16();
		}
		stringConstants.push(units);
	}

	const bigintCount = r.count(16);
	const bigintConstants: Array<bigint> = [];
	for (let b = 0; b < bigintCount; ++b) {
		const lo = r.u64();
		const hi = r.u64();
		const value = (hi << 64n) | lo;
		bigintConstants.push((hi & (1n << 63n)) === 0n ? value : value - (1n << 128n));
	}

	const literalTemplateWordCount = r.count(1);
	const literalTemplateData = new Array<number>(literalTemplateWordCount);
	for (let i = 0; i < literalTemplateWordCount; ++i) {
		literalTemplateData[i] = r.fixedU32();
	}

	const cjsModuleFunctionIndices = r.i32Array();

	const functionCount = r.count(1);
	const functions: Array<VmFunction> = [];
	for (let f = 0; f < functionCount; ++f) {
		functions.push(readFunction(r));
	}

	const files: Array<string> = [];
	const sourcePositions: VmDefinition["sourcePositions"] = [];
	const fileCount = r.count(1);
	for (let f = 0; f < fileCount; ++f) {
		const len = r.count(1);
		const buf = new Array<number>(len);
		for (let i = 0; i < len; ++i) {
			buf[i] = r.u8();
		}
		files.push(utf8Decode(buf));
	}
	const sourcePosCount = r.count(4);
	for (let p = 0; p < sourcePosCount; ++p) {
		const line = r.i32();
		const column = r.i32();
		const inlinedFunctionIndex = r.i32();
		const callerPosId = r.i32();
		const pos: VmDefinition["sourcePositions"][number] = { line, column };
		if (inlinedFunctionIndex !== -1) {
			pos.inlinedFunctionIndex = inlinedFunctionIndex;
		}
		if (callerPosId !== -1) {
			pos.callerPosId = callerPosId;
		}
		sourcePositions.push(pos);
	}
	void debug;

	const hostInstallCount = r.u32();
	if (hostInstallCount > 0) {
		throw new Error(
			"serialize-vm: host installs are not supported in portable wire definitions",
		);
	}
	if (r.remaining() !== 0) {
		throw new Error("serialize-vm: trailing data");
	}

	return {
		functionCount,
		functions,
		stringConstants,
		bigintConstants,
		literalTemplateData,
		globalCount,
		hostInstalls: [],
		files,
		sourcePositions,
		cjsModuleFunctionIndices,
	};
}

function readFunction(r: Reader): VmFunction {
	const nameStringIndex = r.i32();
	const kind = r.u8();
	const strict = r.u8() !== 0;
	const needsArguments = r.u8() !== 0;
	const isDerivedConstructor = r.u8() !== 0;
	const isClassConstructor = r.u8() !== 0;
	const hasPrototype = r.u8() !== 0;
	const mappedArguments = r.u8() !== 0;
	const argumentSnapshotCount = r.count(1);
	const argumentSnapshotPlanCount = r.count(2);
	const argumentSnapshotPlan: VmFunction["argumentSnapshotPlan"] = [];
	for (let i = 0; i < argumentSnapshotPlanCount; i++) {
		argumentSnapshotPlan.push({ destination: r.i32(), source: r.i32() });
	}
	const mappedArgumentCount = r.count(1);
	const mappedArgumentSlots: Array<number> = [];
	for (let i = 0; i < mappedArgumentCount; i++) mappedArgumentSlots.push(r.i32());
	const parameterCount = r.i32();
	const length = r.i32();
	const registerCount = r.i32();
	const capturedCount = r.i32();
	const fileIndex = r.i32();

	const instructionCount = r.count(1);
	const instructions: Array<VmInstruction> = [];
	let propertyIcCount = 0;
	for (let i = 0; i < instructionCount; ++i) {
		const instruction = readInstruction(r);
		switch (instruction.opcode) {
			case "LOAD_PROPERTY":
			case "LOAD_PROPERTY_STATIC":
			case "STORE_PROPERTY":
			case "STORE_PROPERTY_STATIC":
				instruction.icIndex = propertyIcCount++;
				break;
		}
		instructions.push(instruction);
	}

	const handlerCount = r.count(3);
	const handlers: VmFunction["handlers"] = [];
	for (let h = 0; h < handlerCount; ++h) {
		handlers.push({ startIp: r.i32(), endIp: r.i32(), handlerIp: r.i32() });
	}

	const runCount = r.count(2);
	const runs: Array<{ startIp: number; posId: number }> = [];
	for (let run = 0; run < runCount; ++run) {
		runs.push({ startIp: r.i32(), posId: r.i32() });
	}
	const positions = expandPositions(runs, instructionCount);

	const fn: VmFunction = {
		nameStringIndex,
		isGenerator: kind === 1 || kind === 3,
		isAsync: kind === 2 || kind === 3,
		parameterCount,
		mappedArguments,
		length,
		registerCount,
		capturedCount,
		strict,
		needsArguments,
		argumentSnapshotCount,
		argumentSnapshotPlan,
		mappedArgumentSlots,
		isDerivedConstructor,
		isClassConstructor,
		hasPrototype,
		instructions,
		handlers,
		fileIndex,
		positions,
	};
	validateArgumentSnapshotPrefix(fn);
	validateMappedArguments(fn);
	return fn;
}

/** Inverse of compressPositions: fill each instruction's position forward. */
function expandPositions(
	runs: Array<{ startIp: number; posId: number }>,
	instructionCount: number,
): Array<number> {
	if (runs.length === 0) {
		return [];
	}
	const positions = new Array<number>(instructionCount);
	let runIndex = 0;
	for (let ip = 0; ip < instructionCount; ++ip) {
		while (runIndex + 1 < runs.length && runs[runIndex + 1]!.startIp <= ip) {
			runIndex++;
		}
		positions[ip] = runs[runIndex]!.posId;
	}
	return positions;
}

function readInstruction(r: Reader): VmInstruction {
	const opcode = WIRE_OPCODES[r.u8()];
	switch (opcode) {
		case "MOVE":
			return { opcode, dst: r.i32(), src: r.i32() };
		case "RETURN":
			return { opcode, value: r.i32() };
		case "THROW":
			return { opcode, value: r.i32() };
		case "JUMP_IF":
			return { opcode, cond: r.i32(), targetIp: r.i32() };
		case "JUMP":
			return { opcode, targetIp: r.i32() };
		case "CREATE_NUMBER":
			return { opcode, dst: r.i32(), value: r.i32() };
		case "CREATE_F64":
			return { opcode, dst: r.i32(), value: r.f64() };
		case "CREATE_BOOLEAN":
			return { opcode, dst: r.i32(), value: r.u8() !== 0 };
		case "CREATE_STRING":
			return { opcode, dst: r.i32(), stringIndex: r.i32() };
		case "CREATE_BIGINT":
			return { opcode, dst: r.i32(), bigintIndex: r.i32() };
		case "CREATE_OBJECT":
			return { opcode, dst: r.i32() };
		case "CREATE_UNDEFINED":
			return { opcode, dst: r.i32() };
		case "CREATE_EMPTY":
			return { opcode, dst: r.i32() };
		case "CREATE_NULL":
			return { opcode, dst: r.i32() };
		case "CREATE_ARGUMENTS_OBJECT":
			return { opcode, dst: r.i32() };
		case "LOAD_ARGUMENT_COUNT":
			return { opcode, dst: r.i32() };
		case "LOAD_ARGUMENT": {
			const dst = r.i32();
			const index = r.i32();
			if (index < 0) throw new RangeError("serialize-vm: negative argument index");
			return { opcode, dst, index };
		}
		case "LOAD_STATIC_ARGUMENT": {
			const dst = r.i32();
			const direct = r.i32();
			const fallback = r.i32();
			const index = r.i32();
			if (index < 0) throw new RangeError("serialize-vm: negative argument index");
			return { opcode, dst, direct, fallback, index };
		}
		case "LOAD_THIS":
			return { opcode, dst: r.i32() };
		case "LOAD_NEW_TARGET":
			return { opcode, dst: r.i32() };
		case "LOAD_CALLEE":
			return { opcode, dst: r.i32() };
		case "CATCH":
			return { opcode, dst: r.i32() };
		case "CREATE_PRIVATE_NAME":
			return { opcode, dst: r.i32() };
		case "CREATE_PRIVATE_NAMES": {
			const ownerFunctionIndex = r.i32();
			const count = r.i32();
			const capturedIndices = r.i32Array();
			if (count < 1 || capturedIndices.length !== count) {
				throw new RangeError("serialize-vm: invalid private-name batch");
			}
			return { opcode, ownerFunctionIndex, capturedIndices };
		}
		case "CREATE_OBJECT_SHAPED": {
			const instruction: Extract<VmInstruction, { opcode: "CREATE_OBJECT_SHAPED" }> = {
				opcode,
				dst: r.i32(),
				count: r.i32(),
				keyStringIndices: r.i32Array(),
				valueRegisters: r.i32Array(),
			};
			if (
				instruction.count < 1 ||
				instruction.count > 32 ||
				instruction.keyStringIndices.length !== instruction.count ||
				instruction.valueRegisters.length !== instruction.count
			) {
				throw new RangeError("serialize-vm: invalid shaped object operands");
			}
			return instruction;
		}
		case "CREATE_ARRAY":
			return { opcode, dst: r.i32(), length: r.i32() };
		case "INSTANTIATE_LITERAL_TEMPLATE":
			return { opcode, dst: r.i32(), templateOffset: r.i32() };
		case "CREATE_MODULE_NAMESPACE":
			return { opcode, dst: r.i32(), nameIndices: r.i32Array(), slots: r.i32Array() };
		case "CREATE_TEMPLATE_OBJECT":
			return {
				opcode,
				dst: r.i32(),
				cacheSlot: r.i32(),
				cookedIndices: r.i32Array(),
				rawIndices: r.i32Array(),
			};
		case "CREATE_FUNCTION":
			return { opcode, dst: r.i32(), functionIndex: r.i32() };
		case "CALL":
			return {
				opcode,
				dst: r.i32(),
				callee: r.i32(),
				thisValue: r.i32(),
				argumentCount: r.i32(),
				arguments: r.i32Array(),
			};
		case "CONSTRUCT":
			return {
				opcode,
				dst: r.i32(),
				callee: r.i32(),
				argumentCount: r.i32(),
				arguments: r.i32Array(),
			};
		case "TRY_BEGIN":
			return { opcode, handlerIp: 0 };
		case "TRY_END":
			return { opcode };
		case "GENERATOR_START":
			return { opcode };
		case "ASYNC_START":
			return { opcode };
		case "WITH_EXIT":
			return { opcode };
		case "ENV_POP":
			return { opcode };
		case "YIELD":
			return { opcode, yieldedSrc: r.i32(), valueDst: r.i32(), modeDst: r.i32() };
		case "TERMINAL_YIELD":
			return { opcode, yieldedSrc: r.i32() };
		case "AWAIT":
			return { opcode, awaitedSrc: r.i32(), valueDst: r.i32(), modeDst: r.i32() };
		case "LOAD_INTRINSIC": {
			const dst = r.i32();
			const intrinsic = WIRE_INTRINSICS[r.u16()];
			return { opcode, dst, intrinsic } as Extract<
				VmInstruction,
				{ opcode: "LOAD_INTRINSIC" }
			>;
		}
		case "LOAD_CAPTURED":
			return { opcode, dst: r.i32(), ownerFunctionIndex: r.i32(), index: r.i32() };
		case "GUARD_FUNCTION_INDEX":
			return { opcode, dst: r.i32(), callee: r.i32(), functionIndex: r.i32() };
		case "STORE_CAPTURED":
			return { opcode, src: r.i32(), ownerFunctionIndex: r.i32(), index: r.i32() };
		case "ENV_PUSH":
			return { opcode, scopeId: r.i32(), slotCount: r.i32() };
		case "ENV_COPY":
			return { opcode, scopeId: r.i32(), slotCount: r.i32() };
		case "LOAD_GLOBAL":
			return { opcode, dst: r.i32(), index: r.i32() };
		case "STORE_GLOBAL":
			return { opcode, src: r.i32(), index: r.i32() };
		case "LOAD_PROPERTY":
			return { opcode, dst: r.i32(), object: r.i32(), key: r.i32(), icIndex: -1 };
		case "LOAD_PROPERTY_STATIC":
			return {
				opcode,
				dst: r.i32(),
				object: r.i32(),
				stringIndex: r.i32(),
				icIndex: -1,
			};
		case "DELETE_PROPERTY":
			return { opcode, dst: r.i32(), object: r.i32(), key: r.i32() };
		case "TO_PROPERTY_KEY":
			return { opcode, dst: r.i32(), object: r.i32(), key: r.i32() };
		case "LOAD_PRIVATE":
			return { opcode, dst: r.i32(), object: r.i32(), key: r.i32() };
		case "HAS_PRIVATE":
			return { opcode, dst: r.i32(), object: r.i32(), key: r.i32() };
		case "STORE_PROPERTY":
			return {
				opcode,
				object: r.i32(),
				key: r.i32(),
				value: r.i32(),
				icIndex: -1,
			};
		case "STORE_PROPERTY_STATIC":
			return {
				opcode,
				object: r.i32(),
				value: r.i32(),
				stringIndex: r.i32(),
				icIndex: -1,
			};
		case "DEFINE_PRIVATE":
			return { opcode, object: r.i32(), key: r.i32(), value: r.i32() };
		case "STORE_PRIVATE":
			return { opcode, object: r.i32(), key: r.i32(), value: r.i32() };
		case "INIT_PRIVATE_FIELDS": {
			const object = r.i32();
			const count = r.i32();
			const keyRegisters = r.i32Array();
			if (count < 1 || keyRegisters.length !== count) {
				throw new RangeError("serialize-vm: invalid private-field batch");
			}
			return { opcode, object, keyRegisters };
		}
		case "STORE_SUPER_PROPERTY":
			return { opcode, object: r.i32(), key: r.i32(), value: r.i32(), receiver: r.i32() };
		case "LOAD_SUPER_PROPERTY":
			return { opcode, dst: r.i32(), object: r.i32(), key: r.i32(), receiver: r.i32() };
		case "LOAD_PROTOTYPE":
			return { opcode, dst: r.i32(), object: r.i32() };
		case "GET_ITERATOR":
			return { opcode, iteratorDst: r.i32(), nextDst: r.i32(), source: r.i32() };
		case "GET_ASYNC_ITERATOR":
			return { opcode, iteratorDst: r.i32(), nextDst: r.i32(), source: r.i32() };
		case "ITERATOR_NEXT":
			return { opcode, resultDst: r.i32(), iterator: r.i32(), next: r.i32() };
		case "ITERATOR_STEP":
			return {
				opcode,
				valueDst: r.i32(),
				doneDst: r.i32(),
				iterator: r.i32(),
				next: r.i32(),
			};
		case "ITERATOR_CLOSE":
			return { opcode, iterator: r.i32(), normal: r.u8() !== 0 };
		case "FOR_IN_KEYS":
			return { opcode, dst: r.i32(), source: r.i32() };
		case "CALL_SPREAD":
			return {
				opcode,
				dst: r.i32(),
				callee: r.i32(),
				thisValue: r.i32(),
				argumentsArray: r.i32(),
			};
		case "CONSTRUCT_SPREAD":
			return { opcode, dst: r.i32(), callee: r.i32(), argumentsArray: r.i32() };
		case "CONSTRUCT_SUPER":
			return { opcode, dst: r.i32(), parent: r.i32(), argumentsArray: r.i32() };
		case "CONSTRUCT_SUPER_EXPLICIT":
			return {
				opcode,
				dst: r.i32(),
				parent: r.i32(),
				argumentsArray: r.i32(),
				newTarget: r.i32(),
			};
		case "SET_THIS":
			return { opcode, value: r.i32() };
		case "MERGE_DATA_PROPERTIES":
			return { opcode, target: r.i32(), src: r.i32() };
		case "DEFINE_ACCESSOR":
			return {
				opcode,
				object: r.i32(),
				key: r.i32(),
				accessor: r.i32(),
				isSetter: r.u8() !== 0,
				enumerable: r.u8() !== 0,
			};
		case "DEFINE_PROPERTY":
			return {
				opcode,
				object: r.i32(),
				key: r.i32(),
				value: r.i32(),
				enumerable: r.u8() !== 0,
				writable: r.u8() !== 0,
				configurable: r.u8() !== 0,
			};
		case "SET_PROTOTYPE":
			return { opcode, object: r.i32(), prototype: r.i32(), literal: r.u8() !== 0 };
		case "SET_FUNCTION_NAME":
			return { opcode, func: r.i32(), key: r.i32(), prefix: r.u8() };
		case "LOAD_UNDECLARED":
			return { opcode, dst: r.i32(), nameStringIndex: r.i32() };
		case "LOAD_GLOBAL_PROPERTY":
			return { opcode, dst: r.i32(), nameStringIndex: r.i32() };
		case "WITH_GET":
			return { opcode, dst: r.i32(), nameStringIndex: r.i32() };
		case "STORE_GLOBAL_PROPERTY":
			return {
				opcode,
				src: r.i32(),
				nameStringIndex: r.i32(),
				declaration: r.u8() !== 0,
				declarationConfigurable: r.u8() !== 0,
			};
		case "INIT_GLOBAL_VARS": {
			const count = r.i32();
			const instruction: Extract<VmInstruction, { opcode: "INIT_GLOBAL_VARS" }> = {
				opcode,
				nameStringIndices: r.i32Array(),
				declarationConfigurable: r.u8() !== 0,
			};
			if (count < 1 || instruction.nameStringIndices.length !== count) {
				throw new RangeError("serialize-vm: invalid global-var initialization batch");
			}
			return instruction;
		}
		case "THROW_IF_TDZ":
			return { opcode, src: r.i32(), nameStringIndex: r.i32() };
		case "WITH_ENTER":
			return { opcode, object: r.i32() };
		case "WITH_SET":
			return { opcode, found: r.i32(), value: r.i32(), nameStringIndex: r.i32() };
		case "IS_EMPTY":
			return { opcode, dst: r.i32(), src: r.i32() };
		case "REQUIRE_COERCIBLE":
			return { opcode, src: r.i32() };
		case "CHECK_SUPER_CLASS":
			return { opcode, parent: r.i32() };
		case "CREATE_REST_ARGUMENTS":
			return { opcode, dst: r.i32(), startIndex: r.i32() };
		case "ARRAY_REST":
			return { opcode, dst: r.i32(), src: r.i32(), startIndex: r.i32() };
		case "COPY_DATA_PROPERTIES":
			return {
				opcode,
				dst: r.i32(),
				src: r.i32(),
				excludedCount: r.i32(),
				excluded: r.i32Array(),
			};
		case "BINARY":
			return {
				opcode,
				dst: r.i32(),
				left: r.i32(),
				right: r.i32(),
				operator: WIRE_BINOPS[r.u8()] as Extract<
					VmInstruction,
					{ opcode: "BINARY" }
				>["operator"],
			};
		case "UNARY":
			return {
				opcode,
				dst: r.i32(),
				src: r.i32(),
				operator: WIRE_UNOPS[r.u8()] as Extract<
					VmInstruction,
					{ opcode: "UNARY" }
				>["operator"],
			};
		case "TYPEOF_COMPARE": {
			const dst = r.i32();
			const src = r.i32();
			const expected = WIRE_TYPEOF_RESULTS[r.u8()];
			if (expected === undefined) {
				throw new RangeError("serialize-vm: invalid typeof result");
			}
			return { opcode, dst, src, expected, negated: r.u8() !== 0 };
		}
	}
	throw new Error(`serialize-vm: unhandled opcode tag for ${String(opcode)}`);
}
