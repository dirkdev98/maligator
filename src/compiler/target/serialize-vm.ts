import type { CorePropertyPlacement } from "../core/core-ir-regions.ts";
import {
	buildArgumentSnapshotPlan,
	compressPositions,
	decodeVmValueOperand,
	vmGuardIsWorldInvariant,
	vmInstructionWriteRegisters,
	VM_DIRECT_BUILTIN_OPERATIONS,
	VM_GUARDED_BUILTIN_OPERATIONS,
	VM_MATH_BINARY_NUMBER_OPERATIONS,
	VM_MATH_UNARY_NUMBER_OPERATIONS,
} from "./lower-vm.ts";
import type {
	VmDefinition,
	VmFunction,
	VmInstruction,
	VmRegion,
	VmSemanticProtectorFact,
} from "./lower-vm.ts";

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
 * mirrors them. Before 1.0, tags and operand layouts may change freely when the
 * representation improves; every incompatible change bumps WIRE_VERSION so stale
 * cached buffers are rejected and rebuilt instead of being misread.
 */

export const WIRE_MAGIC = 0x574c414d; // "MALW" little-endian
// Internal wire formats are hard cut-overs: stale artifacts must rebuild.
export const WIRE_VERSION = 18;
// Keep in sync with runtime/src/heap_string.h.
export const MAX_STRING_CODE_UNITS = 16 * 1024 * 1024;

const MAX_REGION_ANCHORS = 8;
const MAX_REGION_CLAIMS = 96;
const MAX_REGION_ORDINARY_BLOCKS = 64;
const MAX_STRING_SPLIT_CURSOR_LENGTH_LOADS = 64;
const TAGGED_GUARDED_BUILTIN_OPERATIONS = [
	"Map.prototype.get",
	"Map.prototype.set",
	"Set.prototype.add",
	"String.prototype.split",
	"String.prototype.trim",
	"String.prototype.slice",
	...VM_GUARDED_BUILTIN_OPERATIONS.filter((operation) => operation.startsWith("Math.")),
	"RegExp.prototype.exec",
	...VM_GUARDED_BUILTIN_OPERATIONS.filter(
		(operation) =>
			operation.startsWith("Array.prototype.") && operation !== "Array.prototype.push",
	),
] as const;

function taggedGuardedBuiltinOperation(operation: string | undefined): number {
	if (
		operation === undefined ||
		operation === "Array.prototype.push" ||
		operation === "String.prototype.charCodeAt"
	) {
		return 0;
	}
	const index = (TAGGED_GUARDED_BUILTIN_OPERATIONS as ReadonlyArray<string>).indexOf(
		operation,
	);
	if (index < 0) throw new RangeError(`serialize-vm: unsupported builtin ${operation}`);
	return index + 1;
}

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
	"CALL_SPREAD_ITERABLE",
	"MATH_UNARY_NUMBER",
	"MATH_BINARY_NUMBER",
	"CALL_BUILTIN",
] as const;

const OPCODE_TAG = new Map<string, number>(WIRE_OPCODES.map((name, i) => [name, i]));

function mathUnaryNumberTag(operation: string): number {
	const tag = (VM_MATH_UNARY_NUMBER_OPERATIONS as ReadonlyArray<string>).indexOf(
		operation,
	);
	if (tag < 0) throw new RangeError(`serialize-vm: unsupported Math op ${operation}`);
	return tag;
}

function mathBinaryNumberTag(operation: string): number {
	const tag = (VM_MATH_BINARY_NUMBER_OPERATIONS as ReadonlyArray<string>).indexOf(
		operation,
	);
	if (tag < 0) throw new RangeError(`serialize-vm: unsupported Math op ${operation}`);
	return tag;
}

function directBuiltinTag(operation: string): number {
	const tag = (VM_DIRECT_BUILTIN_OPERATIONS as ReadonlyArray<string>).indexOf(operation);
	if (tag < 0)
		throw new RangeError(`serialize-vm: unsupported direct builtin ${operation}`);
	return tag;
}

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
	private ensure(bytes: number): void {
		if (bytes < 0 || this.pos + bytes > this.view.byteLength) {
			throw new RangeError("serialize-vm: truncated or corrupt buffer");
		}
	}
	u8(): number {
		this.ensure(1);
		const v = this.view.getUint8(this.pos);
		this.pos += 1;
		return v;
	}
	u16(): number {
		this.ensure(2);
		const v = this.view.getUint16(this.pos, true);
		this.pos += 2;
		return v;
	}
	fixedU32(): number {
		this.ensure(4);
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
		this.ensure(8);
		const v = this.view.getFloat64(this.pos, true);
		this.pos += 8;
		return v;
	}
	u64(): bigint {
		this.ensure(8);
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

function stringSplitCursorGuardMasks(
	license: Extract<VmRegion, { kind: "string-split-cursor" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError("serialize-vm: unsupported String.split cursor dependency");
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "on-demand" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 3
	) {
		throw new RangeError("serialize-vm: invalid String.split cursor guard plan");
	}
	return { dependencyMask, obligationMask };
}

function stringSplitProjectionGuardMasks(
	license: Extract<VmRegion, { kind: "string-split-projection" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError(
				"serialize-vm: unsupported String.split projection dependency",
			);
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "whole-region" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 3
	) {
		throw new RangeError("serialize-vm: invalid String.split projection guard plan");
	}
	return { dependencyMask, obligationMask };
}

function regexpExecProjectionGuardMasks(
	license: Extract<VmRegion, { kind: "regexp-exec-projection" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError("serialize-vm: unsupported RegExp.exec projection dependency");
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "whole-region" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 3
	) {
		throw new RangeError("serialize-vm: invalid RegExp.exec projection guard plan");
	}
	return { dependencyMask, obligationMask };
}

function regexpIteratorProjectionGuardMasks(
	license: Extract<VmRegion, { kind: "regexp-iterator-projection" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError(
				"serialize-vm: unsupported RegExp iterator projection dependency",
			);
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "on-demand" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 3
	) {
		throw new RangeError("serialize-vm: invalid RegExp iterator projection guard plan");
	}
	return { dependencyMask, obligationMask };
}

/**
 * Re-check a decoded `call-fallback` placement. Core owns the proof that the load
 * is dead on the fast path; the wire boundary re-proves only what a corrupt or
 * stale image could break — that the deferred load produces the call's callee and
 * shares its handler coverage, so its throw is still caught in the same place.
 */
function propertyPlacementHolds(
	fn: VmFunction,
	placement: CorePropertyPlacement,
	propertyIp: number,
	callIp: number,
): boolean {
	if (placement === "in-place") return true;
	if (placement !== "call-fallback") return false;
	const property = fn.instructions[propertyIp];
	const call = fn.instructions[callIp];
	if (property?.opcode !== "LOAD_PROPERTY_STATIC" || call?.opcode !== "CALL")
		return false;
	if (call.callee !== property.dst) return false;
	const covering = (ip: number): string =>
		fn.handlers
			.filter((handler) => ip >= handler.startIp && ip < handler.endIp)
			.map((handler) => handler.handlerIp)
			.sort((left, right) => left - right)
			.join(",");
	return covering(propertyIp) === covering(callIp);
}

/** Core's property-producer placement travels as a closed two-value tag. */
function readPropertyPlacement(r: Reader): CorePropertyPlacement {
	const tag = r.u8();
	if (tag > 1) throw new RangeError("serialize-vm: invalid region property placement");
	return tag === 1 ? "call-fallback" : "in-place";
}

function writePropertyPlacement(w: Writer, placement: CorePropertyPlacement): void {
	if (placement !== "in-place" && placement !== "call-fallback") {
		throw new RangeError("serialize-vm: invalid region property placement");
	}
	w.u8(placement === "call-fallback" ? 1 : 0);
}

function stringSliceNumberGuardMasks(
	license: Extract<VmRegion, { kind: "string-slice-number" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError("serialize-vm: unsupported String.slice Number dependency");
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "none" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 1
	) {
		throw new RangeError("serialize-vm: invalid String.slice Number guard plan");
	}
	return { dependencyMask, obligationMask };
}

function stackObjectPlanGuardMasks(
	license: Extract<VmRegion, { kind: "stack-object-plan" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "primitive-methods") {
			dependencyMask |= 2;
		} else {
			throw new RangeError("serialize-vm: unsupported stack-object dependency");
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		(license.materialization !== "none" && license.materialization !== "on-demand") ||
		![0, 1, 2].includes(dependencyMask) ||
		obligationMask !== (license.materialization === "none" ? 1 : 3)
	) {
		throw new RangeError("serialize-vm: invalid stack-object guard plan");
	}
	return { dependencyMask, obligationMask };
}

const SEMANTIC_PROTECTOR_TAGS = {
	"primitive-methods": 1,
	"watched-methods": 2,
	"array-elements": 3,
} as const;

function semanticProtectorGuardMasks(fact: VmSemanticProtectorFact): {
	dependencyMask: number;
	obligationMask: number;
} {
	let dependencyMask = 0;
	for (const dependency of fact.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === fact.family) {
			dependencyMask |= 1 << SEMANTIC_PROTECTOR_TAGS[fact.family];
		} else {
			throw new RangeError("serialize-vm: mismatched semantic protector dependency");
		}
	}
	let obligationMask = 0;
	for (const obligation of fact.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	const epochMask = 1 << SEMANTIC_PROTECTOR_TAGS[fact.family];
	if ((dependencyMask !== 1 && dependencyMask !== epochMask) || obligationMask !== 1) {
		throw new RangeError("serialize-vm: invalid semantic protector fact");
	}
	return { dependencyMask, obligationMask };
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
	const debug = options.debugInfo !== false;
	const w = new Writer();

	w.fixedU32(WIRE_MAGIC);
	w.fixedU32(WIRE_VERSION);
	w.u32(debug ? FLAG_HAS_DEBUG : 0);
	w.u32(def.globalCount);
	const entrypoint = utf8Encode(def.entrypointPath);
	w.u32(entrypoint.length);
	for (const byte of entrypoint) w.u8(byte);

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

	w.u32(def.hostInstalls.length);
	for (const install of def.hostInstalls) {
		const installer = utf8Encode(install.installer);
		w.u32(installer.length);
		for (const byte of installer) w.u8(byte);
		w.u32(install.exports.length);
		for (const entry of install.exports) {
			const name = utf8Encode(entry.name);
			w.u32(name.length);
			for (const byte of name) w.u8(byte);
			w.i32(entry.slot);
		}
	}

	const semanticProtectors = [...(def.semanticProtectors ?? [])];
	if (
		semanticProtectors.length > 3 ||
		new Set(semanticProtectors.map((fact) => fact.family)).size !==
			semanticProtectors.length
	) {
		throw new RangeError("serialize-vm: duplicate semantic protector facts");
	}
	w.u32(semanticProtectors.length);
	for (const fact of semanticProtectors) {
		const { dependencyMask, obligationMask } = semanticProtectorGuardMasks(fact);
		w.u8(SEMANTIC_PROTECTOR_TAGS[fact.family]);
		w.u8(dependencyMask);
		w.u8(obligationMask);
	}

	// Native-code generation needs metadata that the interpreter ignores. Keep it
	// in the portable definition so a content-addressed frontend cache can restore
	// a byte-for-byte equivalent AOT input instead of rerunning analysis and IR
	// lowering. The C loader validates and skips this tail.
	w.u32(def.functions.length);
	for (const fn of def.functions) {
		w.u8(fn.gcRootRegisters === undefined ? 0 : 1);
		w.i32Array([...(fn.gcRootRegisters ?? [])]);

		const representationTag = (representation: string): number =>
			representation === "boxed"
				? 0
				: representation === "number"
					? 1
					: representation === "boolean"
						? 2
						: -1;
		if (
			fn.registerRepresentations.length !== fn.registerCount ||
			fn.registerRepresentations.some(
				(representation, register) =>
					representationTag(representation) < 0 ||
					(register < fn.parameterCount && representation !== "boxed"),
			)
		) {
			throw new RangeError("serialize-vm: invalid register representations");
		}
		w.u32(fn.registerRepresentations.length);
		for (const representation of fn.registerRepresentations) {
			w.u8(representationTag(representation));
		}

		const instructionMetadata = fn.instructions
			.map((instruction, instructionIndex) => ({ instruction, instructionIndex }))
			.filter(({ instruction }) => {
				if (instruction.opcode === "CALL") {
					return (
						instruction.directFunctionIndex !== undefined ||
						instruction.directFunctionCall === true ||
						instruction.directCallTargetFunctionIndex !== undefined ||
						instruction.guardedBuiltinCall !== undefined
					);
				}
				if (instruction.opcode === "CONSTRUCT") {
					return instruction.directFunctionIndex !== undefined;
				}
				if (
					instruction.opcode === "LOAD_PROPERTY" ||
					instruction.opcode === "LOAD_PROPERTY_STATIC" ||
					instruction.opcode === "STORE_PROPERTY"
				) {
					return (
						instruction.opcode === "LOAD_PROPERTY_STATIC" &&
						instruction.primitiveStringLength === true
					);
				}
				if (instruction.opcode === "CREATE_ARRAY") {
					return instruction.freshDenseReserveLength !== undefined;
				}
				return false;
			});
		w.u32(instructionMetadata.length);
		for (const { instruction, instructionIndex } of instructionMetadata) {
			w.u32(instructionIndex);
			if (instruction.opcode === "CALL") {
				const guardedBuiltin = instruction.guardedBuiltinCall;
				const guardedOperation = guardedBuiltin?.operation;
				const guardedDependency = guardedBuiltin?.guard.dependencies[0];
				if (
					(instruction.directFunctionIndex !== undefined &&
						(!Number.isInteger(instruction.directFunctionIndex) ||
							instruction.directFunctionIndex < 0 ||
							instruction.directFunctionIndex >= def.functions.length)) ||
					(instruction.directCallTargetFunctionIndex !== undefined &&
						(!Number.isInteger(instruction.directCallTargetFunctionIndex) ||
							instruction.directCallTargetFunctionIndex < 0 ||
							instruction.directCallTargetFunctionIndex >= def.functions.length ||
							instruction.directFunctionCall !== true)) ||
					(guardedBuiltin !== undefined &&
						(guardedBuiltin.guard.dependencies.length !== 1 ||
							guardedBuiltin.guard.obligations.length !== 1 ||
							guardedBuiltin.guard.obligations[0] !== "fallback" ||
							guardedDependency === undefined ||
							(guardedDependency.kind === "world"
								? guardedDependency.fact !== "primordials.locked"
								: guardedDependency.family !== "watched-methods")))
				) {
					throw new RangeError("serialize-vm: invalid CALL specialization metadata");
				}
				if (
					instruction.directStringCharCodeAtPosition !== undefined &&
					guardedOperation !== "String.prototype.charCodeAt"
				) {
					throw new RangeError("serialize-vm: mismatched guarded builtin metadata");
				}
				w.u8(1);
				w.i32(instruction.directFunctionIndex ?? -1);
				w.i32(instruction.directCallTargetFunctionIndex ?? -1);
				w.u8(
					(instruction.directFunctionCall === true ? 1 : 0) |
						(guardedOperation === "Array.prototype.push" ? 2 : 0) |
						(guardedOperation === "String.prototype.charCodeAt" ? 4 : 0) |
						(instruction.directStringCharCodeAtPosition === "inBounds" ? 32 : 0) |
						(guardedDependency?.kind === "world" ? 64 : 0),
				);
				w.u8(taggedGuardedBuiltinOperation(guardedOperation));
			} else if (instruction.opcode === "CONSTRUCT") {
				if (
					!Number.isInteger(instruction.directFunctionIndex) ||
					instruction.directFunctionIndex! < 0 ||
					instruction.directFunctionIndex! >= def.functions.length
				) {
					throw new RangeError("serialize-vm: invalid direct CONSTRUCT target");
				}
				w.u8(2);
				w.i32(instruction.directFunctionIndex!);
			} else if (
				instruction.opcode === "CREATE_ARRAY" &&
				instruction.freshDenseReserveLength !== undefined
			) {
				if (
					!Number.isInteger(instruction.freshDenseReserveLength) ||
					instruction.freshDenseReserveLength < 1 ||
					instruction.freshDenseReserveLength > 65_536
				) {
					throw new RangeError("serialize-vm: invalid indexed-fill reserve metadata");
				}
				w.u8(12);
				w.i32(instruction.freshDenseReserveLength);
			} else if (
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				instruction.primitiveStringLength === true
			) {
				if (
					String.fromCharCode(...(def.stringConstants[instruction.stringIndex] ?? [])) !==
					"length"
				) {
					throw new RangeError("serialize-vm: invalid primitive-String length hint");
				}
				w.u8(11);
			}
		}

		const regions = [...(fn.regions ?? [])];
		w.u32(regions.length);
		const claimedRegionInstructions = new Set<number>();
		for (const region of regions) {
			validateRegion(fn, region, claimedRegionInstructions, def.stringConstants);
			const kindTag =
				region.kind === "string-split-cursor"
					? 2
					: region.kind === "string-split-projection"
						? 4
						: region.kind === "regexp-exec-projection"
							? 5
							: region.kind === "regexp-iterator-projection"
								? 6
								: region.kind === "string-slice-number"
									? 7
									: region.kind === "stack-object-plan"
										? 11
										: 14;
			const representationTag = kindTag;
			const materializationTag =
				region.license.materialization === "none"
					? 0
					: region.license.materialization === "on-demand"
						? 1
						: 2;
			const { dependencyMask, obligationMask } =
				region.kind === "string-split-cursor"
					? stringSplitCursorGuardMasks(region.license)
					: region.kind === "string-split-projection"
						? stringSplitProjectionGuardMasks(region.license)
						: region.kind === "regexp-exec-projection"
							? regexpExecProjectionGuardMasks(region.license)
							: region.kind === "regexp-iterator-projection"
								? regexpIteratorProjectionGuardMasks(region.license)
								: region.kind === "string-slice-number"
									? stringSliceNumberGuardMasks(region.license)
									: region.kind === "stack-object-plan"
										? stackObjectPlanGuardMasks(region.license)
										: { dependencyMask: 0, obligationMask: 1 };
			w.u8(kindTag);
			w.u8(region.composition === "overlay" ? 1 : 0);
			w.i32Array([...region.anchors]);
			w.i32Array([...region.claimedIps]);
			w.i32Array([...region.controlFlow.ordinaryBlockIps]);
			w.i32Array([...region.controlFlow.exceptionalHandlerIps]);
			w.u32(region.cost.score);
			w.u32(region.cost.metadataOperations);
			w.u8(representationTag);
			w.u8(region.license.genericTwin === "retained" ? 1 : 0);
			w.u8(materializationTag);
			w.u8(dependencyMask);
			w.u8(obligationMask);
			w.u8(region.license.admission.validity === "once" ? 1 : 0);
			w.i32(region.license.admission.anchorIp);
			switch (region.kind) {
				case "string-split-cursor":
					w.i32(region.propertyIp);
					writePropertyPlacement(w, region.propertyPlacement);
					w.u8(region.splitIdentity === "authority-invariant" ? 1 : 0);
					w.u8(region.trimIdentity === "authority-invariant" ? 1 : 0);
					w.i32(region.callee);
					w.i32(region.receiver);
					w.i32(region.separator);
					w.i32Array([...region.resultRegisters]);
					w.i32(region.index);
					w.i32(region.elementIp);
					w.i32(region.trimPropertyIp);
					w.i32(region.trimIcIndex);
					w.i32(region.trimCallIp);
					w.i32Array([...region.primitiveStringLengthIps]);
					w.i32(region.exitIp);
					break;
				case "string-split-projection":
					w.i32(region.propertyIp);
					writePropertyPlacement(w, region.propertyPlacement);
					w.u8(region.splitIdentity === "authority-invariant" ? 1 : 0);
					w.i32(region.callIp);
					w.i32(region.callee);
					w.i32(region.receiver);
					w.i32(region.separatorStringIndex);
					w.i32Array([...region.resultRegisters]);
					w.u32(region.loads.length);
					for (const load of region.loads) {
						w.i32(load.ip);
						w.u8(load.kind === "element" ? 1 : 2);
						w.i32(load.kind === "element" ? load.index! : -1);
						w.i32(load.dst);
					}
					break;
				case "numeric-fusion":
					w.u8(region.runtimeGuard === "number-operands" ? 1 : 0);
					w.u32(region.pairs.length);
					for (const pair of region.pairs) {
						w.i32(pair.firstIp);
						w.i32(pair.finishIp);
						w.u8(pair.firstUsePosition);
					}
					break;
				case "regexp-exec-projection":
					w.i32(region.propertyIp);
					writePropertyPlacement(w, region.propertyPlacement);
					w.i32(region.callIp);
					w.u8(region.lockedFreshLiteral ? 1 : 0);
					w.i32(region.lockedLiteral?.constructorIntrinsicIp ?? -1);
					w.i32(region.lockedLiteral?.constructIp ?? -1);
					w.i32(region.callee);
					w.i32(region.receiver);
					w.i32(region.input);
					w.i32(region.result);
					w.i32Array([...region.resultRegisters]);
					w.u32(region.nullChecks.length);
					for (const check of region.nullChecks) {
						w.i32(check.comparisonIp);
						w.i32(check.nullIp);
					}
					w.u8(region.lastIndexEffect === "retained-call-twin" ? 1 : 0);
					w.u32(region.loads.length);
					for (const load of region.loads) {
						w.i32(load.ip);
						w.i32(load.keyIp);
						w.i32(load.captureIndex);
						w.i32(load.dst);
						const consumer = load.consumer;
						w.u8(
							consumer === undefined
								? 0
								: consumer.kind === "length"
									? 1
									: consumer.kind === "charCodeAtZero"
										? 2
										: consumer.kind === "number"
											? 3
											: 4,
						);
						if (consumer?.kind === "length") {
							w.i32(consumer.propertyIp);
						} else if (consumer?.kind === "charCodeAtZero") {
							w.i32(consumer.propertyIp);
							w.i32(consumer.callIp);
							w.i32(consumer.zeroIp ?? -1);
							w.u8(consumer.methodIdentity === "authority-invariant" ? 1 : 0);
						} else if (consumer?.kind === "number") {
							w.i32(consumer.intrinsicIp);
							w.i32(consumer.callIp);
						} else if (consumer?.kind === "asciiCaseLength") {
							w.i32(consumer.upperPropertyIp);
							w.i32(consumer.upperCallIp);
							w.i32(consumer.lowerPropertyIp);
							w.i32(consumer.lowerIcIndex);
							w.i32(consumer.lowerCallIp);
							w.i32Array([...consumer.resultMoveIps]);
							w.i32(consumer.lengthPropertyIp);
							w.u8(consumer.methodIdentity === "authority-invariant" ? 1 : 0);
						}
					}
					break;
				case "regexp-iterator-projection":
					w.i32(region.stepIp);
					w.i32(region.doneBranchIp);
					w.i32(region.exitIp);
					w.i32(region.iterator);
					w.i32(region.next);
					w.i32(region.value);
					w.i32(region.done);
					w.i32Array([...region.resultRegisters]);
					w.u8(region.statefulEffect === "iterator-last-index-retained-step" ? 1 : 0);
					w.u8(region.runtimeGuard === "exact-brand-next-realm-regexp" ? 1 : 0);
					w.u32(region.loads.length);
					for (const load of region.loads) {
						w.i32(load.ip);
						w.i32(load.keyIp);
						w.i32(load.captureIndex);
						w.i32(load.dst);
						w.i32(load.numberIntrinsicIp);
						w.i32(load.numberCallIp);
					}
					break;
				case "string-slice-number":
					w.i32(region.propertyIp);
					writePropertyPlacement(w, region.propertyPlacement);
					w.u8(region.builtinIdentities === "authority-invariant" ? 1 : 0);
					w.i32(region.sliceCallIp);
					w.i32(region.sliceStartIp);
					w.i32(region.numberIntrinsicIp);
					w.i32(region.numberCallIp);
					w.i32(region.numberCallee);
					w.i32(region.receiver);
					w.f64(region.sliceStart);
					w.i32(region.result);
					break;
				case "stack-object-plan":
					w.u32(region.sites.length);
					for (const site of region.sites) {
						w.i32(site.allocationIp);
						w.i32(site.slotCount);
						w.u32(site.accesses.length);
						for (const access of site.accesses) {
							w.i32(access.ip);
							w.i32(access.slot);
						}
						w.i32(site.inheritedAccessIp ?? -1);
						w.u32(site.materializations.length);
						for (const materialization of site.materializations) {
							w.i32(materialization.ip);
							w.u8(1);
						}
					}
					break;
			}
		}
	}

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
	let expectedLiteralShape = 0;
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
			case "CREATE_OBJECT_SHAPED":
				if (instruction.shapeCacheIndex !== expectedLiteralShape) {
					throw new RangeError(
						`serialize-vm: literal shape index ${instruction.shapeCacheIndex}, expected ${expectedLiteralShape}`,
					);
				}
				expectedLiteralShape++;
				break;
		}
	}
}

function validateRegionEnvelope(
	fn: VmFunction,
	region: VmRegion,
	claimed: Set<number>,
): void {
	const instructionIpValid = (ip: number) =>
		Number.isSafeInteger(ip) && ip >= 0 && ip < fn.instructions.length;
	if (
		region.anchors.length === 0 ||
		region.anchors.length > MAX_REGION_ANCHORS ||
		new Set(region.anchors).size !== region.anchors.length ||
		region.anchors.some((ip) => !instructionIpValid(ip)) ||
		region.claimedIps.length === 0 ||
		region.claimedIps.length > MAX_REGION_CLAIMS ||
		new Set(region.claimedIps).size !== region.claimedIps.length ||
		region.claimedIps.some(
			(ip) =>
				!instructionIpValid(ip) || (region.composition !== "overlay" && claimed.has(ip)),
		) ||
		region.anchors.some((ip) => !region.claimedIps.includes(ip)) ||
		region.controlFlow.ordinaryBlockIps.length === 0 ||
		region.controlFlow.ordinaryBlockIps.length > MAX_REGION_ORDINARY_BLOCKS ||
		new Set(region.controlFlow.ordinaryBlockIps).size !==
			region.controlFlow.ordinaryBlockIps.length ||
		region.controlFlow.ordinaryBlockIps.some((ip) => !instructionIpValid(ip)) ||
		region.controlFlow.exceptionalHandlerIps.length > MAX_REGION_ORDINARY_BLOCKS ||
		new Set(region.controlFlow.exceptionalHandlerIps).size !==
			region.controlFlow.exceptionalHandlerIps.length ||
		region.controlFlow.exceptionalHandlerIps.some(
			(ip) =>
				!instructionIpValid(ip) ||
				region.controlFlow.ordinaryBlockIps.includes(ip) ||
				!fn.handlers.some((handler) => handler.handlerIp === ip),
		) ||
		(region.kind !== "regexp-iterator-projection" &&
			region.kind !== "string-slice-number" &&
			region.controlFlow.exceptionalHandlerIps.length !== 0) ||
		!Number.isSafeInteger(region.cost.score) ||
		region.cost.score <= 0 ||
		region.cost.score > 0xffff_ffff ||
		!Number.isSafeInteger(region.cost.metadataOperations) ||
		region.cost.metadataOperations <= 0 ||
		region.cost.metadataOperations > MAX_REGION_CLAIMS ||
		!instructionIpValid(region.license.admission.anchorIp) ||
		!region.claimedIps.includes(region.license.admission.anchorIp)
	) {
		throw new RangeError("serialize-vm: invalid region envelope");
	}
}

function validateRegion(
	fn: VmFunction,
	region: VmRegion,
	claimed: Set<number>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): void {
	validateRegionEnvelope(fn, region, claimed);
	switch (region.kind) {
		case "string-split-cursor":
			validateStringSplitCursorRegion(fn, region);
			break;
		case "string-split-projection":
			validateStringSplitProjectionRegion(fn, region, stringConstants);
			break;
		case "regexp-exec-projection":
			validateRegExpExecProjectionRegion(fn, region, stringConstants);
			break;
		case "regexp-iterator-projection":
			validateRegExpIteratorProjectionRegion(fn, region);
			break;
		case "string-slice-number":
			validateStringSliceNumberRegion(fn, region, stringConstants);
			break;
		case "stack-object-plan":
			validateStackObjectPlanRegion(fn, region);
			break;
		case "numeric-fusion":
			validateNumericFusionRegion(fn, region);
			break;
	}
	if (region.composition !== "overlay") {
		for (const ip of region.claimedIps) claimed.add(ip);
	}
}

function validateNumericFusionRegion(
	fn: VmFunction,
	region: Extract<VmRegion, { kind: "numeric-fusion" }>,
): void {
	const payloadIps = region.pairs.flatMap((pair) => [pair.firstIp, pair.finishIp]);
	const startOperators = new Set([
		"+",
		"-",
		"*",
		"/",
		"%",
		"&",
		"|",
		"^",
		"<<",
		">>",
		">>>",
	]);
	const finishOperators = new Set([
		...startOperators,
		"<",
		"<=",
		">",
		">=",
		"==",
		"!=",
		"===",
		"!==",
	]);
	if (
		region.composition !== "overlay" ||
		region.license.guard.dependencies.length !== 0 ||
		region.license.guard.obligations.length !== 1 ||
		region.license.guard.obligations[0] !== "fallback" ||
		region.license.genericTwin !== "retained" ||
		region.license.materialization !== "none" ||
		region.representation !== "binary-pairs-f64" ||
		region.runtimeGuard !== "number-operands" ||
		region.pairs.length === 0 ||
		region.pairs.length > 32 ||
		region.anchors.length !== 2 ||
		region.anchors[0] !== region.pairs[0]!.firstIp ||
		region.anchors[1] !== region.pairs[0]!.finishIp ||
		new Set(payloadIps).size !== payloadIps.length ||
		payloadIps.length !== region.claimedIps.length ||
		payloadIps.some((ip) => !region.claimedIps.includes(ip)) ||
		region.cost.score !== region.pairs.length ||
		region.cost.metadataOperations !== payloadIps.length ||
		region.pairs.some((pair) => {
			const first = fn.instructions[pair.firstIp];
			const finish = fn.instructions[pair.finishIp];
			return (
				first?.opcode !== "BINARY" ||
				finish?.opcode !== "BINARY" ||
				!startOperators.has(first.operator) ||
				!finishOperators.has(finish.operator) ||
				(pair.firstUsePosition !== 1 && pair.firstUsePosition !== 2) ||
				(pair.firstUsePosition === 1 ? finish.left : finish.right) !== first.dst ||
				pair.firstIp >= pair.finishIp
			);
		})
	) {
		throw new RangeError("serialize-vm: invalid numeric-fusion region");
	}
}

function validateStackObjectPlanRegion(
	fn: VmFunction,
	region: Extract<VmRegion, { kind: "stack-object-plan" }>,
): void {
	const { dependencyMask } = stackObjectPlanGuardMasks(region.license);
	const payload = new Set<number>();
	const allocationIps = new Set<number>();
	let inheritedAccessCount = 0;
	let materializationCount = 0;
	let totalSlots = 0;
	let valid =
		region.representation === "activation-local-fixed-shape-objects" &&
		region.sites.length > 0 &&
		region.sites.length <= 8 &&
		region.anchors.length === region.sites.length &&
		region.controlFlow.exceptionalHandlerIps.length === 0;
	for (let siteIndex = 0; siteIndex < region.sites.length; siteIndex++) {
		const site = region.sites[siteIndex]!;
		const allocation = fn.instructions[site.allocationIp];
		if (
			allocationIps.has(site.allocationIp) ||
			region.anchors[siteIndex] !== site.allocationIp ||
			(allocation?.opcode !== "CREATE_OBJECT" &&
				allocation?.opcode !== "CREATE_OBJECT_SHAPED") ||
			(allocation.opcode === "CREATE_OBJECT"
				? site.slotCount !== 0
				: allocation.count !== site.slotCount) ||
			site.slotCount < 0 ||
			site.slotCount > 256
		) {
			valid = false;
		}
		allocationIps.add(site.allocationIp);
		totalSlots += site.slotCount;
		payload.add(site.allocationIp);
		for (const access of site.accesses) {
			const instruction = fn.instructions[access.ip];
			if (
				(instruction?.opcode !== "LOAD_PROPERTY_STATIC" &&
					instruction?.opcode !== "STORE_PROPERTY_STATIC") ||
				access.slot < 0 ||
				access.slot >= site.slotCount ||
				allocation?.opcode !== "CREATE_OBJECT_SHAPED" ||
				allocation.keyStringIndices[access.slot] !== instruction.stringIndex ||
				payload.has(access.ip)
			) {
				valid = false;
			}
			payload.add(access.ip);
		}
		if (site.inheritedAccessIp !== undefined) {
			inheritedAccessCount++;
			if (
				fn.instructions[site.inheritedAccessIp]?.opcode !== "LOAD_PROPERTY_STATIC" ||
				payload.has(site.inheritedAccessIp)
			) {
				valid = false;
			}
			payload.add(site.inheritedAccessIp);
		}
		for (const materialization of site.materializations) {
			materializationCount++;
			const instruction = fn.instructions[materialization.ip];
			if (
				materialization.kind !== "return" ||
				instruction?.opcode !== "RETURN" ||
				payload.has(materialization.ip)
			) {
				valid = false;
			}
			payload.add(materialization.ip);
		}
	}
	if (
		totalSlots > 256 ||
		(inheritedAccessCount === 0 ? dependencyMask !== 0 : dependencyMask === 0) ||
		(region.license.materialization === "on-demand") !==
			(materializationCount > 0 || inheritedAccessCount > 0) ||
		region.cost.metadataOperations !== payload.size ||
		payload.size !== region.claimedIps.length ||
		region.claimedIps.some((ip) => !payload.has(ip)) ||
		region.claimedIps.some((ip) => !region.controlFlow.ordinaryBlockIps.includes(ip))
	) {
		valid = false;
	}
	if (!valid) throw new RangeError("serialize-vm: invalid stack-object plan region");
}

function validateStringSliceNumberRegion(
	fn: VmFunction,
	region: Extract<VmRegion, { kind: "string-slice-number" }>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): void {
	stringSliceNumberGuardMasks(region.license);
	const property = fn.instructions[region.propertyIp];
	const sliceCall = fn.instructions[region.sliceCallIp];
	const sliceStartInstruction = fn.instructions[region.sliceStartIp];
	const numberIntrinsic = fn.instructions[region.numberIntrinsicIp];
	const numberCall = fn.instructions[region.numberCallIp];
	const numberArgument =
		numberCall?.opcode === "CALL" && numberCall.arguments[0] !== undefined
			? decodeVmValueOperand(numberCall.arguments[0])
			: undefined;
	const expectedBuiltinIdentities =
		sliceCall?.opcode === "CALL" &&
		sliceCall.guardedBuiltinCall !== undefined &&
		vmGuardIsWorldInvariant(sliceCall.guardedBuiltinCall.guard)
			? "authority-invariant"
			: "runtime-guarded";
	const payload = new Set([
		region.propertyIp,
		region.sliceCallIp,
		region.sliceStartIp,
		region.numberIntrinsicIp,
		region.numberCallIp,
	]);
	const activeHandlers = new Set<number>();
	for (const ip of region.claimedIps) {
		for (const handler of fn.handlers) {
			if (ip >= handler.startIp && ip < handler.endIp) {
				activeHandlers.add(handler.handlerIp);
			}
		}
	}
	if (
		region.representation !== "primitive-string-span-number" ||
		region.anchors.length !== 2 ||
		region.anchors[0] !== region.sliceCallIp ||
		region.anchors[1] !== region.numberCallIp ||
		property?.opcode !== "LOAD_PROPERTY_STATIC" ||
		String.fromCharCode(...(stringConstants[property.stringIndex] ?? [])) !== "slice" ||
		sliceCall?.opcode !== "CALL" ||
		sliceCall.guardedBuiltinCall?.operation !== "String.prototype.slice" ||
		sliceCall.arguments.length !== 1 ||
		property.dst !== sliceCall.callee ||
		property.object !== sliceCall.thisValue ||
		(sliceStartInstruction?.opcode !== "CREATE_NUMBER" &&
			sliceStartInstruction?.opcode !== "CREATE_F64") ||
		!Object.is(sliceStartInstruction.value, region.sliceStart) ||
		!Number.isFinite(region.sliceStart) ||
		numberIntrinsic?.opcode !== "LOAD_INTRINSIC" ||
		numberIntrinsic.intrinsic !== "Number" ||
		numberCall?.opcode !== "CALL" ||
		numberCall.callee !== numberIntrinsic.dst ||
		numberCall.callee !== region.numberCallee ||
		numberCall.arguments.length !== 1 ||
		numberArgument?.kind !== "register" ||
		numberArgument.register !== sliceCall.dst ||
		region.builtinIdentities !== expectedBuiltinIdentities ||
		!propertyPlacementHolds(
			fn,
			region.propertyPlacement,
			region.propertyIp,
			region.sliceCallIp,
		) ||
		(region.propertyPlacement === "call-fallback" &&
			region.builtinIdentities !== "authority-invariant") ||
		region.receiver !== sliceCall.thisValue ||
		region.result !== numberCall.dst ||
		activeHandlers.size !== region.controlFlow.exceptionalHandlerIps.length ||
		region.controlFlow.exceptionalHandlerIps.some((ip) => !activeHandlers.has(ip)) ||
		region.cost.metadataOperations !== payload.size ||
		payload.size !== region.claimedIps.length ||
		region.claimedIps.some((ip) => !payload.has(ip))
	) {
		throw new RangeError("serialize-vm: invalid String.slice Number region");
	}
}

function validateRegExpExecProjectionRegion(
	fn: VmFunction,
	region: Extract<VmRegion, { kind: "regexp-exec-projection" }>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): void {
	regexpExecProjectionGuardMasks(region.license);
	const property = fn.instructions[region.propertyIp];
	const call = fn.instructions[region.callIp];
	const aliases = new Set(region.resultRegisters);
	let valid =
		region.representation === "regexp-capture-spans" &&
		region.lastIndexEffect === "retained-call-twin" &&
		region.anchors.length === 2 &&
		region.anchors[0] === region.callIp &&
		region.anchors[1] === region.loads[0]?.ip &&
		property?.opcode === "LOAD_PROPERTY_STATIC" &&
		String.fromCharCode(...(stringConstants[property.stringIndex] ?? [])) === "exec" &&
		call?.opcode === "CALL" &&
		call.guardedBuiltinCall?.operation === "RegExp.prototype.exec" &&
		call.arguments.length === 1 &&
		property.dst === call.callee &&
		property.object === call.thisValue &&
		// Encoding invariant, not a placement decision: reverse-postorder layout emits a
		// producer's block before its consumer's, so an in-place load precedes its call.
		// Whether the load runs there at all is `propertyPlacement`, checked next.
		region.propertyIp < region.callIp &&
		propertyPlacementHolds(
			fn,
			region.propertyPlacement,
			region.propertyIp,
			region.callIp,
		) &&
		(region.propertyPlacement !== "call-fallback" || region.lockedFreshLiteral) &&
		region.callee === call.callee &&
		region.receiver === call.thisValue &&
		region.input === call.arguments[0] &&
		region.result === call.dst &&
		aliases.has(call.dst) &&
		region.resultRegisters.length > 0 &&
		region.resultRegisters.length <= MAX_REGION_CLAIMS &&
		new Set(region.resultRegisters).size === region.resultRegisters.length &&
		region.resultRegisters.every(
			(register) =>
				Number.isInteger(register) && register >= 0 && register < fn.registerCount,
		) &&
		region.loads.length > 0 &&
		region.loads.length <= 8;
	for (const check of region.nullChecks) {
		const comparison = fn.instructions[check.comparisonIp];
		const nullValue = fn.instructions[check.nullIp];
		if (
			comparison?.opcode !== "BINARY" ||
			(comparison.operator !== "===" && comparison.operator !== "!==") ||
			nullValue?.opcode !== "CREATE_NULL" ||
			(!aliases.has(comparison.left) && !aliases.has(comparison.right)) ||
			(comparison.left !== nullValue.dst && comparison.right !== nullValue.dst)
		) {
			valid = false;
		}
	}
	if (region.lockedFreshLiteral !== (region.lockedLiteral !== undefined)) valid = false;
	if (region.lockedLiteral !== undefined) {
		const intrinsic = fn.instructions[region.lockedLiteral.constructorIntrinsicIp];
		const construct = fn.instructions[region.lockedLiteral.constructIp];
		if (
			!region.license.guard.dependencies.every(
				(dependency) => dependency.kind === "world",
			) ||
			intrinsic?.opcode !== "LOAD_INTRINSIC" ||
			intrinsic.intrinsic !== "RegExp" ||
			construct?.opcode !== "CONSTRUCT" ||
			construct.callee !== intrinsic.dst ||
			construct.dst !== region.receiver
		) {
			valid = false;
		}
	}
	const payload = new Set<number>([region.propertyIp, region.callIp]);
	for (const check of region.nullChecks) {
		payload.add(check.comparisonIp);
		payload.add(check.nullIp);
	}
	if (region.lockedLiteral !== undefined) {
		payload.add(region.lockedLiteral.constructorIntrinsicIp);
		payload.add(region.lockedLiteral.constructIp);
	}
	const indices = new Set<number>();
	const expectedProjectedStringMethodIdentity = vmGuardIsWorldInvariant(
		region.license.guard,
	)
		? "authority-invariant"
		: "runtime-guarded";
	const staticPropertyMatches = (
		instruction: VmInstruction | undefined,
		object: number,
		name: string,
	): instruction is Extract<VmInstruction, { opcode: "LOAD_PROPERTY_STATIC" }> =>
		instruction?.opcode === "LOAD_PROPERTY_STATIC" &&
		instruction.object === object &&
		String.fromCharCode(...(stringConstants[instruction.stringIndex] ?? [])) === name;
	for (const load of region.loads) {
		const capture = fn.instructions[load.ip];
		const key = fn.instructions[load.keyIp];
		payload.add(load.ip);
		payload.add(load.keyIp);
		if (
			capture?.opcode !== "LOAD_PROPERTY" ||
			!aliases.has(capture.object) ||
			capture.dst !== load.dst ||
			key?.opcode !== "CREATE_NUMBER" ||
			key.dst !== capture.key ||
			key.value !== load.captureIndex ||
			!Number.isInteger(load.captureIndex) ||
			load.captureIndex <= 0 ||
			load.captureIndex > 0xffff ||
			indices.has(load.captureIndex)
		) {
			valid = false;
		}
		indices.add(load.captureIndex);
		const consumer = load.consumer;
		if (consumer?.kind === "length") {
			payload.add(consumer.propertyIp);
			const length = fn.instructions[consumer.propertyIp];
			valid &&= staticPropertyMatches(length, load.dst, "length");
		} else if (consumer?.kind === "charCodeAtZero") {
			payload.add(consumer.propertyIp);
			payload.add(consumer.callIp);
			if (consumer.zeroIp !== undefined) payload.add(consumer.zeroIp);
			const propertyInstruction = fn.instructions[consumer.propertyIp];
			const callInstruction = fn.instructions[consumer.callIp];
			const argument =
				callInstruction?.opcode === "CALL" && callInstruction.arguments[0] !== undefined
					? decodeVmValueOperand(callInstruction.arguments[0])
					: undefined;
			const zero =
				consumer.zeroIp === undefined ? undefined : fn.instructions[consumer.zeroIp];
			const zeroArgument =
				argument?.kind === "number" && Object.is(argument.value, 0)
					? true
					: argument?.kind === "register" &&
						zero?.opcode === "CREATE_NUMBER" &&
						Object.is(zero.value, 0) &&
						argument.register === zero.dst;
			valid &&=
				consumer.methodIdentity === expectedProjectedStringMethodIdentity &&
				staticPropertyMatches(propertyInstruction, load.dst, "charCodeAt") &&
				callInstruction?.opcode === "CALL" &&
				callInstruction.callee === propertyInstruction.dst &&
				callInstruction.thisValue === load.dst &&
				callInstruction.arguments.length === 1 &&
				zeroArgument;
		} else if (consumer?.kind === "number") {
			payload.add(consumer.intrinsicIp);
			payload.add(consumer.callIp);
			const intrinsic = fn.instructions[consumer.intrinsicIp];
			const numberCall = fn.instructions[consumer.callIp];
			const argument =
				numberCall?.opcode === "CALL" && numberCall.arguments[0] !== undefined
					? decodeVmValueOperand(numberCall.arguments[0])
					: undefined;
			valid &&=
				intrinsic?.opcode === "LOAD_INTRINSIC" &&
				intrinsic.intrinsic === "Number" &&
				numberCall?.opcode === "CALL" &&
				numberCall.callee === intrinsic.dst &&
				numberCall.arguments.length === 1 &&
				argument?.kind === "register" &&
				argument.register === load.dst;
		} else if (consumer?.kind === "asciiCaseLength") {
			for (const ip of [
				consumer.upperPropertyIp,
				consumer.upperCallIp,
				consumer.lowerPropertyIp,
				consumer.lowerCallIp,
				...consumer.resultMoveIps,
				consumer.lengthPropertyIp,
			]) {
				payload.add(ip);
			}
			const upperProperty = fn.instructions[consumer.upperPropertyIp];
			const upperCall = fn.instructions[consumer.upperCallIp];
			const lowerProperty = fn.instructions[consumer.lowerPropertyIp];
			const lowerCall = fn.instructions[consumer.lowerCallIp];
			let lowerResult = lowerCall?.opcode === "CALL" ? lowerCall.dst : -1;
			let movesValid = lowerResult >= 0;
			for (const ip of consumer.resultMoveIps) {
				const move = fn.instructions[ip];
				if (move?.opcode !== "MOVE" || move.src !== lowerResult) {
					movesValid = false;
					break;
				}
				lowerResult = move.dst;
			}
			const lengthProperty = fn.instructions[consumer.lengthPropertyIp];
			valid &&=
				consumer.methodIdentity === expectedProjectedStringMethodIdentity &&
				staticPropertyMatches(upperProperty, load.dst, "toUpperCase") &&
				upperCall?.opcode === "CALL" &&
				upperCall.callee === upperProperty.dst &&
				upperCall.thisValue === load.dst &&
				upperCall.arguments.length === 0 &&
				staticPropertyMatches(lowerProperty, upperCall.dst, "toLowerCase") &&
				lowerCall?.opcode === "CALL" &&
				lowerCall.callee === lowerProperty.dst &&
				lowerCall.thisValue === upperCall.dst &&
				lowerCall.arguments.length === 0 &&
				movesValid &&
				staticPropertyMatches(lengthProperty, lowerResult, "length");
		}
	}
	if (
		!valid ||
		region.cost.metadataOperations !== payload.size ||
		payload.size !== region.claimedIps.length ||
		region.claimedIps.some((ip) => !payload.has(ip))
	) {
		throw new RangeError("serialize-vm: invalid RegExp.exec projection region");
	}
}

function validateRegExpIteratorProjectionRegion(
	fn: VmFunction,
	region: Extract<VmRegion, { kind: "regexp-iterator-projection" }>,
): void {
	regexpIteratorProjectionGuardMasks(region.license);
	const step = fn.instructions[region.stepIp];
	const doneBranch = fn.instructions[region.doneBranchIp];
	const aliases = new Set(region.resultRegisters);
	let valid =
		region.representation === "regexp-iterator-capture-spans" &&
		region.statefulEffect === "iterator-last-index-retained-step" &&
		region.runtimeGuard === "exact-brand-next-realm-regexp" &&
		region.anchors.length === 3 &&
		region.anchors[0] === region.stepIp &&
		region.anchors[1] === region.doneBranchIp &&
		region.anchors[2] === region.loads[0]?.ip &&
		step?.opcode === "ITERATOR_STEP" &&
		doneBranch?.opcode === "JUMP_IF" &&
		// Encoding only: Core certifies the step as the last instruction of its block and
		// the branch as that block's terminator, so the pair is emitted back to back.
		region.doneBranchIp === region.stepIp + 1 &&
		doneBranch.cond === step.doneDst &&
		doneBranch.targetIp === region.exitIp &&
		region.iterator === step.iterator &&
		region.next === step.next &&
		region.value === step.valueDst &&
		region.done === step.doneDst &&
		aliases.has(step.valueDst) &&
		region.resultRegisters.length > 0 &&
		region.resultRegisters.length <= MAX_REGION_CLAIMS &&
		new Set(region.resultRegisters).size === region.resultRegisters.length &&
		region.resultRegisters.every(
			(register) =>
				Number.isInteger(register) && register >= 0 && register < fn.registerCount,
		) &&
		region.loads.length > 0 &&
		region.loads.length <= 8 &&
		region.controlFlow.exceptionalHandlerIps.length > 0;
	const payload = new Set<number>([region.stepIp, region.doneBranchIp]);
	const indices = new Set<number>();
	for (const load of region.loads) {
		const capture = fn.instructions[load.ip];
		const key = fn.instructions[load.keyIp];
		const intrinsic = fn.instructions[load.numberIntrinsicIp];
		const call = fn.instructions[load.numberCallIp];
		const argument =
			call?.opcode === "CALL" && call.arguments[0] !== undefined
				? decodeVmValueOperand(call.arguments[0])
				: undefined;
		if (
			capture?.opcode !== "LOAD_PROPERTY" ||
			!aliases.has(capture.object) ||
			capture.dst !== load.dst ||
			key?.opcode !== "CREATE_NUMBER" ||
			key.dst !== capture.key ||
			key.value !== load.captureIndex ||
			!Number.isInteger(load.captureIndex) ||
			load.captureIndex <= 0 ||
			load.captureIndex > 0xffff ||
			indices.has(load.captureIndex) ||
			intrinsic?.opcode !== "LOAD_INTRINSIC" ||
			intrinsic.intrinsic !== "Number" ||
			call?.opcode !== "CALL" ||
			call.callee !== intrinsic.dst ||
			call.arguments.length !== 1 ||
			argument?.kind !== "register" ||
			argument.register !== load.dst
		) {
			valid = false;
		}
		indices.add(load.captureIndex);
		payload.add(load.ip);
		payload.add(load.keyIp);
		payload.add(load.numberIntrinsicIp);
		payload.add(load.numberCallIp);
	}
	const activeHandlers = new Set<number>();
	for (const ip of region.claimedIps) {
		for (const handler of fn.handlers) {
			if (ip >= handler.startIp && ip < handler.endIp) {
				activeHandlers.add(handler.handlerIp);
			}
		}
	}
	if (
		!valid ||
		activeHandlers.size !== region.controlFlow.exceptionalHandlerIps.length ||
		region.controlFlow.exceptionalHandlerIps.some((ip) => !activeHandlers.has(ip)) ||
		region.cost.metadataOperations !== payload.size ||
		payload.size !== region.claimedIps.length ||
		region.claimedIps.some((ip) => !payload.has(ip))
	) {
		throw new RangeError("serialize-vm: invalid RegExp iterator projection region");
	}
}

function validateStringSplitProjectionRegion(
	fn: VmFunction,
	region: Extract<VmRegion, { kind: "string-split-projection" }>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): void {
	const { dependencyMask } = stringSplitProjectionGuardMasks(region.license);
	const stringConstantEquals = (index: number, value: string): boolean => {
		const constant = stringConstants[index];
		return (
			constant?.length === value.length &&
			constant.every((codeUnit, offset) => codeUnit === value.charCodeAt(offset))
		);
	};
	const callIp = region.anchors[0]!;
	const firstLoadIp = region.anchors[1]!;
	const call = fn.instructions[callIp];
	const property = region.propertyIp < 0 ? undefined : fn.instructions[region.propertyIp];
	const registerValid = (register: number) =>
		Number.isInteger(register) && register >= 0 && register < fn.registerCount;
	// Re-reads the emitted producer to check the decoded certificate's own separator
	// and element indices. A miss rejects the image; nothing here selects code.
	const latestDefinition = (
		register: number,
		beforeIp: number,
	): VmInstruction | undefined => {
		for (let ip = beforeIp - 1; ip >= 0; ip--) {
			const instruction = fn.instructions[ip]!;
			if (vmInstructionWriteRegisters(instruction).includes(register)) return instruction;
		}
		return undefined;
	};
	const callMatches =
		call?.opcode === "CALL"
			? (dependencyMask === 1 || dependencyMask === 4) &&
				region.propertyIp >= 0 &&
				property?.opcode === "LOAD_PROPERTY_STATIC" &&
				property.dst === region.callee &&
				property.object === region.receiver &&
				stringConstantEquals(property.stringIndex, "split") &&
				call.callee === region.callee &&
				call.thisValue === region.receiver &&
				call.guardedBuiltinCall?.operation === "String.prototype.split" &&
				call.guardedBuiltinCall.guard.dependencies.length === 1 &&
				(dependencyMask === 1
					? call.guardedBuiltinCall.guard.dependencies[0]?.kind === "world"
					: call.guardedBuiltinCall.guard.dependencies[0]?.kind === "epoch" &&
						call.guardedBuiltinCall.guard.dependencies[0]?.family ===
							"watched-methods") &&
				call.guardedBuiltinCall.guard.obligations.length === 1 &&
				call.guardedBuiltinCall.guard.obligations[0] === "fallback"
			: call?.opcode === "CALL_BUILTIN" &&
				dependencyMask === 1 &&
				region.propertyIp === -1 &&
				region.callee === -1 &&
				call.operation === "String.prototype.split" &&
				call.thisValue === region.receiver;
	const expectedSplitIdentity =
		call?.opcode === "CALL_BUILTIN" ||
		(call?.opcode === "CALL" &&
			call.guardedBuiltinCall !== undefined &&
			vmGuardIsWorldInvariant(call.guardedBuiltinCall.guard))
			? "authority-invariant"
			: "runtime-guarded";
	const separator =
		(call?.opcode === "CALL" || call?.opcode === "CALL_BUILTIN") &&
		call.arguments.length === 1
			? decodeVmValueOperand(call.arguments[0]!)
			: undefined;
	const separatorMatches =
		separator?.kind === "string"
			? separator.index === region.separatorStringIndex
			: separator?.kind === "register"
				? (() => {
						const definition = latestDefinition(separator.register, callIp);
						return (
							definition?.opcode === "CREATE_STRING" &&
							definition.stringIndex === region.separatorStringIndex
						);
					})()
				: false;
	const resultRegisters = new Set(region.resultRegisters);
	let operationsValid = true;
	for (const load of region.loads) {
		const instruction = fn.instructions[load.ip];
		if (
			(instruction?.opcode !== "LOAD_PROPERTY" &&
				instruction?.opcode !== "LOAD_PROPERTY_STATIC") ||
			!resultRegisters.has(instruction.object) ||
			instruction.dst !== load.dst
		) {
			operationsValid = false;
			break;
		}
		if (load.kind === "length") {
			if (
				instruction.opcode !== "LOAD_PROPERTY_STATIC" ||
				load.index !== undefined ||
				!stringConstantEquals(instruction.stringIndex, "length")
			) {
				operationsValid = false;
				break;
			}
		} else {
			const key =
				instruction.opcode === "LOAD_PROPERTY"
					? latestDefinition(instruction.key, load.ip)
					: undefined;
			if (
				instruction.opcode !== "LOAD_PROPERTY" ||
				!Number.isInteger(load.index) ||
				load.index! < 0 ||
				load.index! > 0xffff ||
				key?.opcode !== "CREATE_NUMBER" ||
				key.value !== load.index
			) {
				operationsValid = false;
				break;
			}
		}
	}
	const elementLoads = region.loads.filter((load) => load.kind === "element");
	const lengthLoads = region.loads.filter((load) => load.kind === "length");
	const operationIps = [
		...(region.propertyIp < 0 ? [] : [region.propertyIp]),
		region.callIp,
		...region.loads.map((load) => load.ip),
	];
	if (
		region.representation !== "projected-elements" ||
		region.license.materialization !== "whole-region" ||
		region.anchors.length !== 2 ||
		region.callIp !== callIp ||
		firstLoadIp !== region.loads[0]?.ip ||
		!callMatches ||
		(call?.opcode !== "CALL" && call?.opcode !== "CALL_BUILTIN") ||
		call.arguments.length !== 1 ||
		!registerValid(region.receiver) ||
		region.resultRegisters.length === 0 ||
		region.resultRegisters.length > MAX_REGION_CLAIMS ||
		resultRegisters.size !== region.resultRegisters.length ||
		region.resultRegisters.some((register) => !registerValid(register)) ||
		!resultRegisters.has(call.dst) ||
		region.separatorStringIndex < 0 ||
		region.separatorStringIndex >= stringConstants.length ||
		stringConstants[region.separatorStringIndex]?.length === 0 ||
		!separatorMatches ||
		region.splitIdentity !== expectedSplitIdentity ||
		!propertyPlacementHolds(fn, region.propertyPlacement, region.propertyIp, callIp) ||
		(region.propertyPlacement === "call-fallback" &&
			region.splitIdentity !== "authority-invariant") ||
		elementLoads.length === 0 ||
		elementLoads.length > 8 ||
		lengthLoads.length > 1 ||
		new Set(elementLoads.map((load) => load.index)).size !== elementLoads.length ||
		new Set(region.loads.map((load) => load.ip)).size !== region.loads.length ||
		region.loads.some(
			(load, index) =>
				load.ip <= callIp || (index > 0 && region.loads[index - 1]!.ip >= load.ip),
		) ||
		!operationsValid ||
		region.cost.metadataOperations !== operationIps.length ||
		new Set(operationIps).size !== operationIps.length ||
		operationIps.length !== region.claimedIps.length ||
		operationIps.some((ip) => !region.claimedIps.includes(ip))
	) {
		throw new RangeError("serialize-vm: invalid String.split projection region metadata");
	}
}

function validateStringSplitCursorRegion(
	fn: VmFunction,
	region: Extract<VmRegion, { kind: "string-split-cursor" }>,
): void {
	stringSplitCursorGuardMasks(region.license);
	const callIp = region.anchors[0]!;
	const headerBranchIp = region.anchors[1]!;
	const lengthIp = region.anchors[2]!;
	const backedgeIp = region.anchors[3]!;
	const call = fn.instructions[callIp];
	const headerBranch = fn.instructions[headerBranchIp];
	const property = region.propertyIp < 0 ? undefined : fn.instructions[region.propertyIp];
	const length = fn.instructions[lengthIp];
	// Encoding only: Core's cursor certificate fixes the header and latch shape, so
	// the wire form names the length load, header branch, and backedge and derives the
	// compare, exit jump, and increment from their fixed offsets. A shape that does not
	// match rejects the image; nothing here decides whether the region applies.
	const compare = fn.instructions[lengthIp + 1];
	const exitJump = fn.instructions[headerBranchIp + 1];
	const element = fn.instructions[region.elementIp];
	const trimProperty = fn.instructions[region.trimPropertyIp];
	const trimCall = fn.instructions[region.trimCallIp];
	const increment = fn.instructions[backedgeIp - 1];
	const backedge = fn.instructions[backedgeIp];
	const operationIps = [
		...(region.propertyIp < 0 ? [] : [region.propertyIp]),
		callIp,
		lengthIp,
		lengthIp + 1,
		headerBranchIp,
		region.elementIp,
		region.trimPropertyIp,
		region.trimCallIp,
		...region.primitiveStringLengthIps,
		backedgeIp - 1,
		backedgeIp,
	];
	const registerValid = (value: number) =>
		Number.isInteger(value) && value >= 0 && value < fn.registerCount;
	const resultRegisters = new Set(region.resultRegisters);
	const callMatches =
		call?.opcode === "CALL"
			? region.propertyIp >= 0 &&
				property?.opcode === "LOAD_PROPERTY_STATIC" &&
				property.dst === region.callee &&
				property.object === region.receiver &&
				call.callee === region.callee &&
				call.guardedBuiltinCall?.operation === "String.prototype.split"
			: call?.opcode === "CALL_BUILTIN" &&
				region.propertyIp === -1 &&
				region.callee === -1 &&
				call.operation === "String.prototype.split";
	const expectedSplitIdentity =
		call?.opcode === "CALL_BUILTIN" ||
		(call?.opcode === "CALL" &&
			call.guardedBuiltinCall !== undefined &&
			vmGuardIsWorldInvariant(call.guardedBuiltinCall.guard))
			? "authority-invariant"
			: "runtime-guarded";
	const expectedTrimIdentity =
		trimCall?.opcode === "CALL" &&
		trimCall.guardedBuiltinCall !== undefined &&
		vmGuardIsWorldInvariant(trimCall.guardedBuiltinCall.guard)
			? "authority-invariant"
			: "runtime-guarded";
	const primitiveLengthIps = new Set(region.primitiveStringLengthIps);
	let primitiveLengthsValid =
		primitiveLengthIps.size === region.primitiveStringLengthIps.length;
	const trimAliases = new Set<number>(trimCall?.opcode === "CALL" ? [trimCall.dst] : []);
	for (let ip = region.trimCallIp + 1; primitiveLengthsValid && ip <= backedgeIp; ip++) {
		const instruction = fn.instructions[ip];
		if (instruction === undefined) {
			primitiveLengthsValid = false;
			break;
		}
		if (primitiveLengthIps.has(ip)) {
			primitiveLengthsValid =
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				trimAliases.has(instruction.object);
		}
		const moveAlias = instruction.opcode === "MOVE" && trimAliases.has(instruction.src);
		if ("dst" in instruction && trimAliases.has(instruction.dst)) {
			trimAliases.delete(instruction.dst);
		}
		if (moveAlias && instruction.opcode === "MOVE") trimAliases.add(instruction.dst);
	}
	if (
		region.representation !== "split-cursor-spans" ||
		region.license.materialization !== "on-demand" ||
		region.anchors.length !== 4 ||
		!callMatches ||
		region.splitIdentity !== expectedSplitIdentity ||
		region.trimIdentity !== expectedTrimIdentity ||
		call === undefined ||
		(call.opcode !== "CALL" && call.opcode !== "CALL_BUILTIN") ||
		call.thisValue !== region.receiver ||
		call.argumentCount !== 1 ||
		call.arguments[0] !== region.separator ||
		region.resultRegisters.length === 0 ||
		region.resultRegisters.length > MAX_REGION_CLAIMS ||
		resultRegisters.size !== region.resultRegisters.length ||
		region.resultRegisters.some((register) => !registerValid(register)) ||
		!resultRegisters.has(call.dst) ||
		!registerValid(region.index) ||
		length?.opcode !== "LOAD_PROPERTY_STATIC" ||
		!resultRegisters.has(length.object) ||
		compare?.opcode !== "BINARY" ||
		compare.operator !== "<" ||
		compare.right !== length.dst ||
		compare.left !== region.index ||
		headerBranchIp !== lengthIp + 2 ||
		headerBranch?.opcode !== "JUMP_IF" ||
		headerBranch.cond !== compare.dst ||
		headerBranch.targetIp !== region.elementIp ||
		exitJump?.opcode !== "JUMP" ||
		exitJump.targetIp !== region.exitIp ||
		region.elementIp !== headerBranchIp + 2 ||
		element?.opcode !== "LOAD_PROPERTY" ||
		!resultRegisters.has(element.object) ||
		element.key !== region.index ||
		region.trimPropertyIp !== region.elementIp + 1 ||
		trimProperty?.opcode !== "LOAD_PROPERTY_STATIC" ||
		trimProperty.object !== element.dst ||
		trimProperty.icIndex !== region.trimIcIndex ||
		region.trimCallIp !== region.trimPropertyIp + 1 ||
		trimCall?.opcode !== "CALL" ||
		trimCall.callee !== trimProperty.dst ||
		trimCall.thisValue !== element.dst ||
		trimCall.argumentCount !== 0 ||
		trimCall.guardedBuiltinCall?.operation !== "String.prototype.trim" ||
		increment?.opcode !== "UNARY" ||
		increment.operator !== "increment" ||
		increment.src !== region.index ||
		increment.dst !== region.index ||
		backedge?.opcode !== "JUMP" ||
		backedge.targetIp !== lengthIp ||
		backedgeIp <= region.trimCallIp ||
		region.exitIp !== backedgeIp + 1 ||
		region.exitIp < 0 ||
		region.exitIp > fn.instructions.length ||
		region.primitiveStringLengthIps.length > MAX_STRING_SPLIT_CURSOR_LENGTH_LOADS ||
		!primitiveLengthsValid ||
		!propertyPlacementHolds(fn, region.propertyPlacement, region.propertyIp, callIp) ||
		(region.propertyPlacement === "call-fallback" &&
			region.splitIdentity !== "authority-invariant") ||
		new Set(operationIps).size !== operationIps.length ||
		operationIps.length !== region.claimedIps.length ||
		operationIps.some(
			(ip) => ip < 0 || ip >= fn.instructions.length || !region.claimedIps.includes(ip),
		) ||
		region.cost.metadataOperations !== operationIps.length
	) {
		throw new RangeError("serialize-vm: invalid String.split cursor region metadata");
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
				i.count > 64 ||
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
		case "MATH_UNARY_NUMBER":
			w.i32(i.dst);
			w.i32(i.src);
			w.u8(mathUnaryNumberTag(i.operation));
			return;
		case "MATH_BINARY_NUMBER":
			w.i32(i.dst);
			w.i32(i.left);
			w.i32(i.right);
			w.u8(mathBinaryNumberTag(i.operation));
			return;
		case "CALL_BUILTIN":
			w.i32(i.dst);
			w.i32(i.thisValue);
			w.i32(i.argumentCount);
			w.i32Array(i.arguments);
			w.u8(directBuiltinTag(i.operation));
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
		case "CALL_SPREAD_ITERABLE":
			w.i32(i.dst);
			w.i32(i.callee);
			w.i32(i.thisValue);
			w.i32(i.iterable);
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
	const entrypointLength = r.count(1);
	const entrypointBytes = new Array<number>(entrypointLength);
	for (let index = 0; index < entrypointLength; index++) {
		entrypointBytes[index] = r.u8();
	}
	const entrypointPath = utf8Decode(entrypointBytes);

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
	const hostInstalls: VmDefinition["hostInstalls"] = [];
	for (let index = 0; index < hostInstallCount; index++) {
		const installerLength = r.count(1);
		const installerBytes = new Array<number>(installerLength);
		for (let byte = 0; byte < installerLength; byte++) {
			installerBytes[byte] = r.u8();
		}
		const hostExports = [];
		const exportCount = r.count(1);
		for (let exportIndex = 0; exportIndex < exportCount; exportIndex++) {
			const nameLength = r.count(1);
			const nameBytes = new Array<number>(nameLength);
			for (let byte = 0; byte < nameLength; byte++) nameBytes[byte] = r.u8();
			hostExports.push({ name: utf8Decode(nameBytes), slot: r.i32() });
		}
		hostInstalls.push({ installer: utf8Decode(installerBytes), exports: hostExports });
	}

	const semanticProtectorCount = r.count(3);
	if (semanticProtectorCount > 3) {
		throw new RangeError("serialize-vm: too many semantic protector facts");
	}
	const semanticProtectors: Array<VmSemanticProtectorFact> = [];
	const seenSemanticProtectors = new Set<VmSemanticProtectorFact["family"]>();
	for (let index = 0; index < semanticProtectorCount; index++) {
		const tag = r.u8();
		const family =
			tag === 1
				? "primitive-methods"
				: tag === 2
					? "watched-methods"
					: tag === 3
						? "array-elements"
						: undefined;
		const dependencyMask = r.u8();
		const obligationMask = r.u8();
		if (
			family === undefined ||
			seenSemanticProtectors.has(family) ||
			(dependencyMask !== 1 && dependencyMask !== 1 << tag) ||
			obligationMask !== 1
		) {
			throw new RangeError("serialize-vm: invalid semantic protector fact");
		}
		seenSemanticProtectors.add(family);
		semanticProtectors.push({
			family,
			guard: {
				dependencies: [
					dependencyMask === 1
						? { kind: "world", fact: "primordials.locked" }
						: { kind: "epoch", family },
				],
				obligations: ["fallback"],
			},
		});
	}

	const compilerMetadataFunctionCount = r.count(1);
	if (compilerMetadataFunctionCount !== functions.length) {
		throw new Error("serialize-vm: compiler metadata function count mismatch");
	}
	for (const fn of functions) {
		const hasGcRootRegisters = r.u8();
		if (hasGcRootRegisters > 1) {
			throw new Error("serialize-vm: invalid GC-root metadata");
		}
		const gcRootRegisters = r.i32Array();
		if (hasGcRootRegisters === 0 && gcRootRegisters.length !== 0) {
			throw new Error("serialize-vm: invalid GC-root metadata");
		}
		if (hasGcRootRegisters === 1) fn.gcRootRegisters = gcRootRegisters;

		const representationCount = r.count(1);
		if (representationCount !== fn.registerCount) {
			throw new Error("serialize-vm: register representation count mismatch");
		}
		fn.registerRepresentations = Array.from(
			{ length: representationCount },
			(_, register) => {
				const tag = r.u8();
				if (tag === 0) return "boxed" as const;
				if (register < fn.parameterCount) {
					throw new Error("serialize-vm: non-boxed parameter representation");
				}
				if (tag === 1) return "number" as const;
				if (tag === 2) return "boolean" as const;
				throw new Error("serialize-vm: invalid register representation tag");
			},
		);

		const instructionMetadataCount = r.count(2);
		let previousInstructionMetadataIndex = -1;
		for (
			let metadataIndex = 0;
			metadataIndex < instructionMetadataCount;
			metadataIndex++
		) {
			const instructionIndex = r.u32();
			if (instructionIndex <= previousInstructionMetadataIndex) {
				throw new RangeError("serialize-vm: unordered compiler instruction metadata");
			}
			previousInstructionMetadataIndex = instructionIndex;
			const instruction = fn.instructions[instructionIndex];
			if (instruction === undefined) {
				throw new RangeError(
					"serialize-vm: compiler instruction metadata index out of range",
				);
			}
			const tag = r.u8();
			if (tag === 1 && instruction.opcode === "CALL") {
				const directFunctionIndex = r.i32();
				const directCallTargetFunctionIndex = r.i32();
				const flags = r.u8();
				const collectionTag = r.u8();
				const guardedBuiltinCount =
					((flags & 2) !== 0 ? 1 : 0) +
					((flags & 4) !== 0 ? 1 : 0) +
					(collectionTag !== 0 ? 1 : 0);
				if (
					directFunctionIndex < -1 ||
					directFunctionIndex >= functions.length ||
					directCallTargetFunctionIndex < -1 ||
					directCallTargetFunctionIndex >= functions.length ||
					flags > 127 ||
					(flags & 24) !== 0 ||
					((flags & 32) !== 0 && (flags & 4) === 0) ||
					(directCallTargetFunctionIndex >= 0 && (flags & 1) === 0) ||
					collectionTag > TAGGED_GUARDED_BUILTIN_OPERATIONS.length ||
					guardedBuiltinCount > 1 ||
					((flags & 64) !== 0 && guardedBuiltinCount !== 1)
				) {
					throw new RangeError("serialize-vm: invalid CALL compiler metadata");
				}
				if (directFunctionIndex >= 0)
					instruction.directFunctionIndex = directFunctionIndex;
				if (directCallTargetFunctionIndex >= 0) {
					instruction.directCallTargetFunctionIndex = directCallTargetFunctionIndex;
				}
				if ((flags & 1) !== 0) instruction.directFunctionCall = true;
				if ((flags & 32) !== 0) instruction.directStringCharCodeAtPosition = "inBounds";
				if (guardedBuiltinCount === 1) {
					const operation =
						(flags & 2) !== 0
							? "Array.prototype.push"
							: (flags & 4) !== 0
								? "String.prototype.charCodeAt"
								: TAGGED_GUARDED_BUILTIN_OPERATIONS[collectionTag - 1]!;
					instruction.guardedBuiltinCall = {
						operation,
						guard: {
							dependencies: [
								(flags & 64) !== 0
									? { kind: "world", fact: "primordials.locked" }
									: { kind: "epoch", family: "watched-methods" },
							],
							obligations: ["fallback"],
						},
					};
				}
			} else if (tag === 2 && instruction.opcode === "CONSTRUCT") {
				const directFunctionIndex = r.i32();
				if (directFunctionIndex < 0 || directFunctionIndex >= functions.length) {
					throw new RangeError("serialize-vm: invalid CONSTRUCT compiler metadata");
				}
				instruction.directFunctionIndex = directFunctionIndex;
			} else if (tag === 12 && instruction.opcode === "CREATE_ARRAY") {
				const reserveLength = r.i32();
				if (reserveLength < 1 || reserveLength > 65_536) {
					throw new RangeError("serialize-vm: invalid indexed-fill reserve metadata");
				}
				instruction.freshDenseReserveLength = reserveLength;
			} else if (tag === 11 && instruction.opcode === "LOAD_PROPERTY_STATIC") {
				if (
					String.fromCharCode(...(stringConstants[instruction.stringIndex] ?? [])) !==
					"length"
				) {
					throw new RangeError("serialize-vm: invalid primitive-String length hint");
				}
				instruction.primitiveStringLength = true;
			} else {
				throw new RangeError(
					"serialize-vm: compiler instruction metadata opcode mismatch",
				);
			}
		}
		const regionCount = r.count(17);
		if (regionCount > 0) {
			const regions: Array<VmRegion> = [];
			const claimed = new Set<number>();
			for (let regionIndex = 0; regionIndex < regionCount; regionIndex++) {
				const kindTag = r.u8();
				const compositionTag = r.u8();
				const anchors = r.i32Array();
				const claimedIps = r.i32Array();
				const ordinaryBlockIps = r.i32Array();
				const exceptionalHandlerIps = r.i32Array();
				const score = r.u32();
				const metadataOperations = r.u32();
				const representationTag = r.u8();
				const genericTwinTag = r.u8();
				const materializationTag = r.u8();
				const dependencyMask = r.u8();
				const obligationMask = r.u8();
				const admissionTag = r.u8();
				const admissionAnchorIp = r.i32();
				const admission = {
					anchorIp: admissionAnchorIp,
					validity: admissionTag === 1 ? ("once" as const) : ("per-use" as const),
				};
				const stringSplitCursorContract =
					kindTag === 2 &&
					representationTag === 2 &&
					materializationTag === 1 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 3;
				const stringSplitProjectionContract =
					kindTag === 4 &&
					representationTag === 4 &&
					materializationTag === 2 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 3;
				const regexpExecProjectionContract =
					kindTag === 5 &&
					representationTag === 5 &&
					materializationTag === 2 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 3;
				const regexpIteratorProjectionContract =
					kindTag === 6 &&
					representationTag === 6 &&
					materializationTag === 1 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 3;
				const stringSliceNumberContract =
					kindTag === 7 &&
					representationTag === 7 &&
					materializationTag === 0 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 1;
				const stackObjectPlanContract =
					kindTag === 11 &&
					representationTag === 11 &&
					[0, 1, 2].includes(dependencyMask) &&
					((materializationTag === 0 && obligationMask === 1) ||
						(materializationTag === 1 && obligationMask === 3));
				const numericFusionContract =
					kindTag === 14 &&
					representationTag === 14 &&
					materializationTag === 0 &&
					dependencyMask === 0 &&
					obligationMask === 1;
				if (
					compositionTag > 1 ||
					(compositionTag === 1) !== numericFusionContract ||
					genericTwinTag !== 1 ||
					admissionTag > 1 ||
					(!stringSplitCursorContract &&
						!stringSplitProjectionContract &&
						!regexpExecProjectionContract &&
						!regexpIteratorProjectionContract &&
						!stringSliceNumberContract &&
						!stackObjectPlanContract &&
						!numericFusionContract)
				) {
					throw new RangeError("serialize-vm: invalid function region contract");
				}
				let region: VmRegion;
				if (kindTag === 2) {
					const propertyIp = r.i32();
					const propertyPlacement = readPropertyPlacement(r);
					const splitIdentityTag = r.u8();
					const trimIdentityTag = r.u8();
					const callee = r.i32();
					const receiver = r.i32();
					const separator = r.i32();
					const resultRegisters = r.i32Array();
					const index = r.i32();
					const elementIp = r.i32();
					const trimPropertyIp = r.i32();
					const trimIcIndex = r.i32();
					const trimCallIp = r.i32();
					const primitiveStringLengthIps = r.i32Array();
					const exitIp = r.i32();
					if (
						splitIdentityTag > 1 ||
						trimIdentityTag > 1 ||
						primitiveStringLengthIps.length > MAX_STRING_SPLIT_CURSOR_LENGTH_LOADS
					) {
						throw new RangeError("serialize-vm: invalid String.split cursor header");
					}
					region = {
						kind: "string-split-cursor",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [
												{
													kind: "world" as const,
													fact: "primordials.locked" as const,
												},
											]
										: [
												{
													kind: "epoch" as const,
													family: "watched-methods" as const,
												},
											],
								obligations: ["fallback" as const, "materialize" as const],
							},
							genericTwin: "retained",
							materialization: "on-demand",
							admission,
						},
						representation: "split-cursor-spans",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						propertyIp,
						propertyPlacement,
						splitIdentity:
							splitIdentityTag === 1 ? "authority-invariant" : "runtime-guarded",
						trimIdentity:
							trimIdentityTag === 1 ? "authority-invariant" : "runtime-guarded",
						callee,
						receiver,
						separator,
						resultRegisters,
						index,
						elementIp,
						trimPropertyIp,
						trimIcIndex,
						trimCallIp,
						primitiveStringLengthIps,
						exitIp,
					};
				} else if (kindTag === 4) {
					const propertyIp = r.i32();
					const propertyPlacement = readPropertyPlacement(r);
					const splitIdentityTag = r.u8();
					const callIp = r.i32();
					const callee = r.i32();
					const receiver = r.i32();
					const separatorStringIndex = r.i32();
					const resultRegisters = r.i32Array();
					if (splitIdentityTag > 1) {
						throw new RangeError("serialize-vm: invalid String.split identity decision");
					}
					const loadCount = r.count(4);
					const loads: Array<
						Extract<VmRegion, { kind: "string-split-projection" }>["loads"][number]
					> = [];
					for (let loadIndex = 0; loadIndex < loadCount; loadIndex++) {
						const ip = r.i32();
						const loadKindTag = r.u8();
						const index = r.i32();
						const dst = r.i32();
						if (
							(loadKindTag !== 1 && loadKindTag !== 2) ||
							(loadKindTag === 2 && index !== -1)
						) {
							throw new RangeError("serialize-vm: invalid String.split projection load");
						}
						loads.push({
							ip,
							kind: loadKindTag === 1 ? "element" : "length",
							...(loadKindTag === 1 ? { index } : {}),
							dst,
						});
					}
					region = {
						kind: "string-split-projection",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [
												{
													kind: "world" as const,
													fact: "primordials.locked" as const,
												},
											]
										: [
												{
													kind: "epoch" as const,
													family: "watched-methods" as const,
												},
											],
								obligations: ["fallback", "materialize"],
							},
							genericTwin: "retained",
							materialization: "whole-region",
							admission,
						},
						representation: "projected-elements",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						propertyIp,
						propertyPlacement,
						splitIdentity:
							splitIdentityTag === 1 ? "authority-invariant" : "runtime-guarded",
						callIp,
						callee,
						receiver,
						separatorStringIndex,
						resultRegisters,
						loads,
					};
				} else if (kindTag === 5) {
					const propertyIp = r.i32();
					const propertyPlacement = readPropertyPlacement(r);
					const callIp = r.i32();
					const lockedFreshLiteral = r.u8();
					const constructorIntrinsicIp = r.i32();
					const constructIp = r.i32();
					const callee = r.i32();
					const receiver = r.i32();
					const input = r.i32();
					const result = r.i32();
					const resultRegisters = r.i32Array();
					const nullCheckCount = r.count(5);
					const nullChecks: Array<{
						comparisonIp: number;
						nullIp: number;
					}> = [];
					for (let check = 0; check < nullCheckCount; check++) {
						nullChecks.push({ comparisonIp: r.i32(), nullIp: r.i32() });
					}
					const lastIndexEffect = r.u8();
					const loadCount = r.count(4);
					const loads: Array<
						Extract<VmRegion, { kind: "regexp-exec-projection" }>["loads"][number]
					> = [];
					for (let loadIndex = 0; loadIndex < loadCount; loadIndex++) {
						const ip = r.i32();
						const keyIp = r.i32();
						const captureIndex = r.i32();
						const dst = r.i32();
						const consumerTag = r.u8();
						let consumer:
							| Extract<
									VmRegion,
									{ kind: "regexp-exec-projection" }
							  >["loads"][number]["consumer"]
							| undefined;
						if (consumerTag === 1) {
							consumer = { kind: "length", propertyIp: r.i32() };
						} else if (consumerTag === 2) {
							const propertyIp = r.i32();
							const callIp = r.i32();
							const zeroIp = r.i32();
							const methodIdentityTag = r.u8();
							if (methodIdentityTag > 1) {
								throw new RangeError(
									"serialize-vm: invalid projected String method identity",
								);
							}
							consumer = {
								kind: "charCodeAtZero",
								methodIdentity:
									methodIdentityTag === 1 ? "authority-invariant" : "runtime-guarded",
								propertyIp,
								callIp,
								...(zeroIp < 0 ? {} : { zeroIp }),
							};
						} else if (consumerTag === 3) {
							consumer = { kind: "number", intrinsicIp: r.i32(), callIp: r.i32() };
						} else if (consumerTag === 4) {
							const upperPropertyIp = r.i32();
							const upperCallIp = r.i32();
							const lowerPropertyIp = r.i32();
							const lowerIcIndex = r.i32();
							const lowerCallIp = r.i32();
							const resultMoveIps = r.i32Array();
							const lengthPropertyIp = r.i32();
							const methodIdentityTag = r.u8();
							if (methodIdentityTag > 1) {
								throw new RangeError(
									"serialize-vm: invalid projected String method identity",
								);
							}
							consumer = {
								kind: "asciiCaseLength",
								methodIdentity:
									methodIdentityTag === 1 ? "authority-invariant" : "runtime-guarded",
								upperPropertyIp,
								upperCallIp,
								lowerPropertyIp,
								lowerIcIndex,
								lowerCallIp,
								resultMoveIps,
								lengthPropertyIp,
							};
						} else if (consumerTag !== 0) {
							throw new RangeError("serialize-vm: invalid RegExp.exec consumer tag");
						}
						loads.push({
							ip,
							keyIp,
							captureIndex,
							dst,
							...(consumer ? { consumer } : {}),
						});
					}
					if (
						lockedFreshLiteral > 1 ||
						lastIndexEffect !== 1 ||
						(lockedFreshLiteral === 0
							? constructorIntrinsicIp !== -1 || constructIp !== -1
							: constructorIntrinsicIp < 0 || constructIp < 0)
					) {
						throw new RangeError("serialize-vm: invalid RegExp.exec projection header");
					}
					region = {
						kind: "regexp-exec-projection",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [{ kind: "world", fact: "primordials.locked" }]
										: [{ kind: "epoch", family: "watched-methods" }],
								obligations: ["fallback", "materialize"],
							},
							genericTwin: "retained",
							materialization: "whole-region",
							admission,
						},
						representation: "regexp-capture-spans",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						propertyIp,
						propertyPlacement,
						callIp,
						lockedFreshLiteral: lockedFreshLiteral === 1,
						...(lockedFreshLiteral === 0
							? {}
							: { lockedLiteral: { constructorIntrinsicIp, constructIp } }),
						callee,
						receiver,
						input,
						result,
						resultRegisters,
						nullChecks,
						lastIndexEffect: "retained-call-twin",
						loads,
					};
				} else if (kindTag === 6) {
					const stepIp = r.i32();
					const doneBranchIp = r.i32();
					const exitIp = r.i32();
					const iterator = r.i32();
					const next = r.i32();
					const value = r.i32();
					const done = r.i32();
					const resultRegisters = r.i32Array();
					const statefulEffect = r.u8();
					const runtimeGuard = r.u8();
					const loadCount = r.count(4);
					const loads: Array<
						Extract<VmRegion, { kind: "regexp-iterator-projection" }>["loads"][number]
					> = [];
					for (let load = 0; load < loadCount; load++) {
						loads.push({
							ip: r.i32(),
							keyIp: r.i32(),
							captureIndex: r.i32(),
							dst: r.i32(),
							numberIntrinsicIp: r.i32(),
							numberCallIp: r.i32(),
						});
					}
					if (statefulEffect !== 1 || runtimeGuard !== 1) {
						throw new RangeError(
							"serialize-vm: invalid RegExp iterator projection header",
						);
					}
					region = {
						kind: "regexp-iterator-projection",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [{ kind: "world", fact: "primordials.locked" }]
										: [{ kind: "epoch", family: "watched-methods" }],
								obligations: ["fallback", "materialize"],
							},
							genericTwin: "retained",
							materialization: "on-demand",
							admission,
						},
						representation: "regexp-iterator-capture-spans",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						stepIp,
						doneBranchIp,
						exitIp,
						iterator,
						next,
						value,
						done,
						resultRegisters,
						statefulEffect: "iterator-last-index-retained-step",
						runtimeGuard: "exact-brand-next-realm-regexp",
						loads,
					};
				} else if (kindTag === 7) {
					const propertyIp = r.i32();
					const propertyPlacement = readPropertyPlacement(r);
					const builtinIdentitiesTag = r.u8();
					const sliceCallIp = r.i32();
					const sliceStartIp = r.i32();
					const numberIntrinsicIp = r.i32();
					const numberCallIp = r.i32();
					const numberCallee = r.i32();
					const receiver = r.i32();
					const sliceStart = r.f64();
					const result = r.i32();
					if (builtinIdentitiesTag > 1) {
						throw new RangeError("serialize-vm: invalid String.slice identity decision");
					}
					region = {
						kind: "string-slice-number",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [{ kind: "world", fact: "primordials.locked" }]
										: [{ kind: "epoch", family: "watched-methods" }],
								obligations: ["fallback"],
							},
							genericTwin: "retained",
							materialization: "none",
							admission,
						},
						representation: "primitive-string-span-number",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						propertyIp,
						propertyPlacement,
						builtinIdentities:
							builtinIdentitiesTag === 1 ? "authority-invariant" : "runtime-guarded",
						sliceCallIp,
						sliceStartIp,
						numberIntrinsicIp,
						numberCallIp,
						numberCallee,
						receiver,
						sliceStart,
						result,
					};
				} else if (kindTag === 11) {
					const siteCount = r.count(5);
					if (siteCount === 0 || siteCount > 8) {
						throw new RangeError("serialize-vm: invalid stack-object site count");
					}
					const sites: Array<
						Extract<VmRegion, { kind: "stack-object-plan" }>["sites"][number]
					> = [];
					for (let siteIndex = 0; siteIndex < siteCount; siteIndex++) {
						const allocationIp = r.i32();
						const slotCount = r.i32();
						const accessCount = r.count(2);
						const accesses: Array<{ ip: number; slot: number }> = [];
						for (let access = 0; access < accessCount; access++) {
							accesses.push({ ip: r.i32(), slot: r.i32() });
						}
						const inheritedAccessIp = r.i32();
						const materializationCount = r.count(2);
						const materializations: Array<{ ip: number; kind: "return" }> = [];
						for (
							let materialization = 0;
							materialization < materializationCount;
							materialization++
						) {
							const ip = r.i32();
							const tag = r.u8();
							if (tag !== 1) {
								throw new RangeError(
									"serialize-vm: invalid stack-object materialization",
								);
							}
							materializations.push({
								ip,
								kind: "return",
							});
						}
						sites.push({
							allocationIp,
							slotCount,
							accesses,
							...(inheritedAccessIp < 0 ? {} : { inheritedAccessIp }),
							materializations,
						});
					}
					region = {
						kind: "stack-object-plan",
						license: {
							guard: {
								dependencies:
									dependencyMask === 0
										? []
										: dependencyMask === 1
											? [{ kind: "world", fact: "primordials.locked" }]
											: [{ kind: "epoch", family: "primitive-methods" }],
								obligations:
									materializationTag === 0 ? ["fallback"] : ["fallback", "materialize"],
							},
							genericTwin: "retained",
							materialization: materializationTag === 0 ? "none" : "on-demand",
							admission,
						},
						representation: "activation-local-fixed-shape-objects",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						sites,
					};
				} else if (kindTag === 14) {
					const runtimeGuardTag = r.u8();
					const pairCount = r.count(2);
					const pairs: Array<
						Extract<VmRegion, { kind: "numeric-fusion" }>["pairs"][number]
					> = [];
					for (let pair = 0; pair < pairCount; pair++) {
						const firstIp = r.i32();
						const finishIp = r.i32();
						const firstUsePosition = r.u8();
						if (firstUsePosition !== 1 && firstUsePosition !== 2) {
							throw new RangeError("serialize-vm: invalid numeric-fusion use position");
						}
						pairs.push({ firstIp, finishIp, firstUsePosition });
					}
					if (runtimeGuardTag !== 1) {
						throw new RangeError("serialize-vm: invalid numeric-fusion guard");
					}
					region = {
						kind: "numeric-fusion",
						license: {
							guard: { dependencies: [], obligations: ["fallback"] },
							genericTwin: "retained",
							materialization: "none",
							admission,
						},
						representation: "binary-pairs-f64",
						composition: "overlay",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						runtimeGuard: "number-operands",
						pairs,
					};
				} else {
					throw new RangeError("serialize-vm: invalid function region kind");
				}
				validateRegion(fn, region, claimed, stringConstants);
				regions.push(region);
			}
			fn.regions = regions;
		}
	}
	if (r.remaining() !== 0) {
		throw new Error("serialize-vm: trailing data");
	}

	return {
		entrypointPath,
		functionCount,
		functions,
		stringConstants,
		bigintConstants,
		literalTemplateData,
		globalCount,
		...(semanticProtectors.length === 0 ? {} : { semanticProtectors }),
		hostInstalls,
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
	let literalShapeCount = 0;
	for (let i = 0; i < instructionCount; ++i) {
		const instruction = readInstruction(r);
		switch (instruction.opcode) {
			case "LOAD_PROPERTY":
			case "LOAD_PROPERTY_STATIC":
			case "STORE_PROPERTY":
			case "STORE_PROPERTY_STATIC":
				instruction.icIndex = propertyIcCount++;
				break;
			case "CREATE_OBJECT_SHAPED":
				instruction.shapeCacheIndex = literalShapeCount++;
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
		registerRepresentations: Array.from({ length: registerCount }, () => "boxed"),
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
				shapeCacheIndex: -1,
			};
			if (
				instruction.count < 1 ||
				instruction.count > 64 ||
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
		case "MATH_UNARY_NUMBER": {
			const dst = r.i32();
			const src = r.i32();
			const operation = VM_MATH_UNARY_NUMBER_OPERATIONS[r.u8()];
			if (operation === undefined) {
				throw new RangeError("serialize-vm: invalid unary numeric Math operation");
			}
			return { opcode, dst, src, operation };
		}
		case "MATH_BINARY_NUMBER": {
			const dst = r.i32();
			const left = r.i32();
			const right = r.i32();
			const operation = VM_MATH_BINARY_NUMBER_OPERATIONS[r.u8()];
			if (operation === undefined) {
				throw new RangeError("serialize-vm: invalid binary numeric Math operation");
			}
			return {
				opcode,
				dst,
				left,
				right,
				operation,
			};
		}
		case "CALL_BUILTIN": {
			const dst = r.i32();
			const thisValue = r.i32();
			const argumentCount = r.i32();
			const arguments_ = r.i32Array();
			const operation = VM_DIRECT_BUILTIN_OPERATIONS[r.u8()];
			if (operation === undefined || argumentCount !== arguments_.length) {
				throw new RangeError("serialize-vm: invalid direct builtin call");
			}
			return {
				opcode,
				dst,
				thisValue,
				argumentCount,
				arguments: arguments_,
				operation,
			};
		}
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
		case "CALL_SPREAD_ITERABLE":
			return {
				opcode,
				dst: r.i32(),
				callee: r.i32(),
				thisValue: r.i32(),
				iterable: r.i32(),
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
