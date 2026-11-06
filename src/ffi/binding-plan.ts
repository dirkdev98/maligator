import { createHash } from "node:crypto";
import type {
	MaligatorFfiCallback,
	MaligatorFfiCount,
	MaligatorFfiFieldFacts,
	MaligatorFfiFunctionFacts,
	MaligatorFfiShape,
	MaligatorFfiValueFacts,
	MaligatorFfiVariant,
} from "../public-api.d.ts";
import type {
	CField,
	CFieldStep,
	CFunction,
	CGlobal,
	CModel,
	CRecord,
} from "./c-model.ts";
import {
	cRecordAccesses,
	cRecordHasConstMembers,
	promotedCFields,
	resolveCFieldPath,
	resolveCType,
} from "./c-model.ts";
import { formatCDeclaration, isCNativeValueType, parseCType } from "./c-type.ts";
import type { CType } from "./c-type.ts";
import type { LibraryFacts } from "./contract.ts";
import { FfiFactError } from "./ffi-error.ts";
import type { FfiText } from "./text.ts";

/**
 * Values that convert the same way in both directions. Record fields, union members
 * and tagged cases describe C storage that a binding both reads and writes, so their
 * nested values are results that inputs lend as they are.
 */
type SharedValue =
	| { readonly kind: "undefined" }
	| { readonly kind: "native"; readonly name: string }
	| { readonly kind: "boolean" }
	/** An exact integer of at most 32 bits; other numbers throw on input. */
	| { readonly kind: "integer"; readonly bits: number; readonly signed: boolean }
	| { readonly kind: "float"; readonly bits: number }
	/** An integer wider than 32 bits, exact in both directions. */
	| { readonly kind: "bigint"; readonly bits: number; readonly signed: boolean }
	/** A struct passed by value as a plain object. */
	| { readonly kind: "record"; readonly name: string }
	| {
			readonly kind: "tagged";
			readonly name: string;
			readonly tag: string;
			readonly cases: ReadonlyArray<{
				readonly literal: string;
				readonly value: JsResult;
			}>;
			readonly alias?: string;
	  }
	| {
			readonly kind: "union";
			readonly name: string;
			readonly of: JsResult;
			readonly alias?: string;
	  };

/** A fixed C array of `length` values, or of characters in `format`. */
interface ArrayValue<Value> {
	readonly kind: "array";
	readonly of: Value;
	readonly length: number;
	readonly format?: "string" | "bytes";
}

/**
 * A value JavaScript lends C for the duration of a call. Mappings follow fixed rules
 * so the same header and facts always produce the same module.
 */
export type JsInput =
	| SharedValue
	| ArrayValue<JsInput>
	/** UTF-8, terminated or byte-counted. */
	| { readonly kind: "string"; readonly nullable: boolean; readonly counted?: true }
	/** Bytes C uses in place; `writable` inputs reject immutable buffers. */
	| { readonly kind: "bytes"; readonly nullable: boolean; readonly writable?: true }
	/** A C array of `element` values, copied from a JavaScript array. */
	| {
			readonly kind: "sequence";
			readonly of: JsInput;
			readonly element: CType;
			readonly nullable: boolean;
	  }
	| CallbackValue
	/**
	 * A resource handle. C receives the handle's pointer, a copy of its struct, or the
	 * struct's address for the library to update in place.
	 */
	| {
			readonly kind: "handle";
			readonly name: string;
			readonly pass: "pointer" | "copy" | "reference";
			readonly nullable: boolean;
	  };

/**
 * A value C hands JavaScript, with the cleanup it leaves: buffers name the `free`
 * that releases C's copy, and handles their `ownership` of the resource.
 */
export type JsResult =
	| SharedValue
	| ArrayValue<JsResult>
	/** UTF-8, terminated or byte-counted, copied into a JavaScript string. */
	| {
			readonly kind: "string";
			readonly nullable: boolean;
			readonly counted?: true;
			readonly free?: string;
	  }
	/** Bytes copied into a Uint8Array. */
	| { readonly kind: "bytes"; readonly nullable: boolean; readonly free?: string }
	/** A C array of `element` values, copied into a JavaScript array. */
	| {
			readonly kind: "sequence";
			readonly of: JsResult;
			readonly element: CType;
			readonly nullable: boolean;
			readonly free?: string;
	  }
	| {
			readonly kind: "callable";
			readonly name: string;
			readonly targetType: string;
			readonly site: string;
			readonly signature: BoundFunction;
			readonly nullable: true;
			readonly owner?: string;
	  }
	/** A resource handle wrapping the pointer C returned or a copy of its struct. */
	| {
			readonly kind: "handle";
			readonly name: string;
			readonly pass: "pointer" | "copy";
			readonly nullable: boolean;
			readonly ownership: HandleOwnership;
			readonly fresh?: true;
	  };

/** A value in either direction, for walks that treat inputs and results alike. */
export type JsValue = JsInput | JsResult;

/**
 * A JavaScript function the library calls through a generated trampoline of the C
 * function type `type`, during the call or, when kept, until it releases it.
 */
type CallbackValue = {
	readonly kind: "callback";
	readonly type: Extract<CType, { kind: "function" }>;
	/**
	 * Per C parameter of the callback: the value C hands JavaScript, the user data it
	 * receives, or the count of a buffer or array parameter, which JavaScript does not see.
	 */
	readonly params: ReadonlyArray<JsResult | "data" | "count">;
	/** Per C parameter: the parameter holding its byte or element count. */
	readonly counts: ReadonlyArray<number | undefined>;
	readonly returns: JsInput;
	readonly returnLifetime?: "call" | "registration";
	readonly resultCount?: {
		readonly param: number;
		readonly bits: number;
		readonly signed: boolean;
	};
	readonly nullable: boolean;
	readonly lifetime: CallbackLifetime;
	readonly route: CallbackRoute;
	/**
	 * Calls from other threads go to the VM thread: `queue` copies the arguments and
	 * lets C continue, `wait` lends them and blocks C until JavaScript returns.
	 */
	readonly thread?: "queue" | "wait";
};

/** Whether `value` carries no result obligation or callable, so C can borrow it. */
function isInput(value: JsValue): value is JsInput {
	switch (value.kind) {
		case "callable":
			return false;
		case "handle":
			return !("ownership" in value);
		case "string":
		case "bytes":
			return !("free" in value && value.free !== undefined);
		case "sequence":
			return !("free" in value && value.free !== undefined) && isInput(value.of);
		case "array":
			return isInput(value.of);
		default:
			return true;
	}
}

/** Whether `value` states the cleanup of everything C hands JavaScript in it. */
function isResult(value: JsValue): value is JsResult {
	switch (value.kind) {
		case "callback":
			return false;
		case "handle":
			return "ownership" in value;
		case "bytes":
			return !("writable" in value && value.writable === true);
		case "sequence":
		case "array":
			return isResult(value.of);
		default:
			return true;
	}
}

/**
 * The fact a gap asks for: a handle type, a callback, typed variants, a pointer role
 * (a handle, buffer, out parameter, or string), text or bytes, an array length or
 * element mapping, a union selection, a result lifetime, a native representation, an
 * ownership choice, or `unsupported` when no fact binds the value.
 */
export type GapCode =
	| "handle"
	| "callback"
	| "variants"
	| "pointer"
	| "text"
	| "array"
	| "shape"
	| "lifetime"
	| "native"
	| "ownership"
	| "unsupported";

type Gapped = { readonly gap: string; readonly code: GapCode };

/** `value`, which its position makes an input; a result obligation in it is a planner defect. */
function inputOf(value: JsValue): JsInput {
	if (!isInput(value))
		throw new Error(`a ${value.kind} input carries a result obligation`);
	return value;
}

/** `value`, which its position makes a result; a callback or unowned handle in it is a planner defect. */
function resultOf(value: JsValue): JsResult {
	if (!isResult(value))
		throw new Error(
			`a ${value.kind} result has a callback or a handle without ownership`,
		);
	return value;
}

/**
 * The input that lends C the storage a field-shaped result describes, for a C array
 * mapped as stored rather than decayed to a pointer.
 */
function lend(value: JsResult): JsInput {
	switch (value.kind) {
		case "callable":
			throw new Error("a native callable cannot be lent to C");
		case "handle":
			return {
				kind: "handle",
				name: value.name,
				pass: value.pass,
				nullable: value.nullable,
			};
		case "string":
			return {
				kind: "string",
				nullable: value.nullable,
				...(value.counted === true ? { counted: true as const } : {}),
			};
		case "bytes":
			return { kind: "bytes", nullable: value.nullable };
		case "sequence":
			return {
				kind: "sequence",
				of: lend(value.of),
				element: value.element,
				nullable: value.nullable,
			};
		case "array":
			return { ...value, of: lend(value.of) };
		default:
			return value;
	}
}

/** `mapping` narrowed to the input its position makes it. */
function inputMapping(mapping: Mapping): Mapping<JsInput> {
	return "gap" in mapping ? mapping : { value: inputOf(mapping.value) };
}

/** `mapping` of C array storage, lent to C as an input. */
function lentMapping(mapping: Mapping): Mapping<JsInput> {
	return "gap" in mapping ? mapping : { value: lend(resultOf(mapping.value)) };
}

/** `mapping` narrowed to the result its position makes it. */
function resultMapping(mapping: Mapping): Mapping<JsResult> {
	return "gap" in mapping ? mapping : { value: resultOf(mapping.value) };
}

/** Who releases the resource behind a handle that a result or field produces. */
export type HandleOwnership =
	/** Closing the handle releases the resource through its destructor. */
	| { readonly kind: "owned" }
	/** The library keeps owning the resource; closing only detaches the handle. */
	| { readonly kind: "borrowed" }
	/** A field result borrowing the owning lifetime of its containing handle type. */
	| { readonly kind: "owner"; readonly owner: string }
	/** A field result the library keeps valid for the whole process. */
	| { readonly kind: "library" };

/** Whether a handle has a lifetime of its own, not one borrowed from an owner or the library. */
export function independentHandle(value: Extract<JsResult, { kind: "handle" }>): boolean {
	return value.ownership.kind === "owned" || value.ownership.kind === "borrowed";
}
type Mapping<Value extends JsValue = JsValue> = { readonly value: Value } | Gapped;

/**
 * How long the library may call a callback. A released or replaced registration may
 * name the input handle `owner` whose destruction root holds its JavaScript values.
 */
export type CallbackLifetime =
	/** Only while the binding runs. */
	| { readonly kind: "call" }
	/** Until the library calls the destructor it received with the user data. */
	| { readonly kind: "released"; readonly owner?: number }
	/**
	 * Until the next call of the setter replaces it; per handle when `key` names the C
	 * parameter whose handle keys the registration.
	 */
	| { readonly kind: "replaced"; readonly key?: number; readonly owner?: number }
	/**
	 * One completion that ends the handle input `param`, passed as C argument `key`;
	 * `handle` is the callback parameter that passes that handle back.
	 */
	| {
			readonly kind: "completion";
			readonly param: number;
			readonly key: number;
			readonly handle?: number;
	  };

/** How a trampoline finds the registration a C call belongs to. */
export type CallbackRoute =
	/** The user data C passes back as callback parameter `param`. */
	| { readonly kind: "data"; readonly param: number }
	/** The user data `function` returns from callback parameter `param`. */
	| { readonly kind: "lookup"; readonly function: string; readonly param: number }
	/**
	 * The registration a replacement setter or close completion keyed by the handle in
	 * callback parameter `param`, or the setter's only registration without one.
	 */
	| { readonly kind: "key"; readonly param?: number }
	/** The callback the running call published in a per-thread slot. */
	| { readonly kind: "scope" };

/** The input handle rooting a registration, which only released and replaced ones name. */
export function registrationOwner(lifetime: CallbackLifetime): number | undefined {
	return lifetime.kind === "released" || lifetime.kind === "replaced"
		? lifetime.owner
		: undefined;
}

/** Whether the library may call `value` after the binding returns. */
export function keptCallback(value: CallbackValue): value is CallbackValue & {
	readonly lifetime: Exclude<CallbackLifetime, { readonly kind: "call" }>;
} {
	return value.lifetime.kind !== "call";
}

export type NumericView =
	| "Int8Array"
	| "Uint8Array"
	| "Int16Array"
	| "Uint16Array"
	| "Int32Array"
	| "Uint32Array"
	| "BigInt64Array"
	| "BigUint64Array"
	| "Float32Array"
	| "Float64Array";

export interface MappedParameter {
	readonly name: string;
	readonly type: CType;
	readonly value: JsInput;
	readonly view?: NumericView;
	/** The view lends storage C may write; ordinary arrays still pass a copy. */
	readonly writable?: true;
}

/** How a binding produces one C argument. */
export type Argument =
	/** Converted from JavaScript parameter `param`. */
	| { readonly kind: "input"; readonly param: number }
	/**
	 * The shared byte or element count of the buffers or arrays in `of`, in a C
	 * integer of `bits` that may be `signed`. With `output`, the address of a local
	 * holding the buffer's size, which the function updates to the count it used and
	 * the binding returns as that output.
	 */
	| {
			readonly kind: "count";
			readonly of: ReadonlyArray<number>;
			readonly bits: number;
			readonly signed: boolean;
			readonly output?: number;
	  }
	/** The address of a zeroed local the function writes; returned as output `output`. */
	| { readonly kind: "out"; readonly output: number }
	/** The address of a local read from parameter `param` and returned as `output`. */
	| { readonly kind: "inout"; readonly param: number; readonly output: number }
	/** The address of a local the function writes with the count of its result. */
	| { readonly kind: "result-count" }
	/** The user data that routes the callback argument `of` to its JavaScript function. */
	| { readonly kind: "callback-data"; readonly of: number }
	/** The destructor the library calls when it drops the kept callback argument `of`. */
	| { readonly kind: "callback-release"; readonly of: number }
	/** A C expression the contract fixes, such as a macro name. */
	| {
			readonly kind: "constant";
			readonly expression: string;
			readonly sizeLimit?: string;
	  };

/** A value the function writes through a pointer, returned beside its result. */
export interface MappedOutput {
	readonly name: string;
	/** The C type of the local holding this output. */
	readonly type: CType;
	readonly value: JsResult;
	/** The C parameter holding this output's byte or element count. */
	readonly count?: number;
	/** Caller storage bounded by a C input parameter or the original JavaScript array. */
	readonly capacity?: number | "input";
}

export interface BoundFunction {
	readonly name: string;
	readonly callsJavaScript?: false;
	readonly global?: GlobalAccessor;
	readonly declaration: CFunction;
	/** The JavaScript parameters, in order. */
	readonly params: ReadonlyArray<MappedParameter>;
	/** How each C argument is produced, by C parameter position. */
	readonly arguments: ReadonlyArray<Argument>;
	readonly returns: JsResult;
	/** For a buffer or array result: the C parameter that carries its count. */
	readonly resultCount?: number;
	/** With outputs, the function returns `{ result, ...outputs }` instead of its result. */
	readonly outputs: ReadonlyArray<MappedOutput>;
	/** The parameter whose handle this destroy function releases, closed after the call. */
	readonly closes?: number;
	readonly initializes?: { readonly param: number; readonly success?: string };
	/** An export that runs the C call on a worker thread and returns a promise. */
	readonly async?: string;
}

/** A missing fact: where in the declaration it is needed and why. */
export interface Gap {
	/** `return`, `param 2 (title)`, or `arguments` for variadics. */
	readonly at: string;
	readonly code: GapCode;
	readonly reason: string;
	/** The C parameter the missing fact belongs to. */
	readonly param?: number;
}

export interface UnboundFunction {
	readonly name: string;
	readonly dispatchOf?: string;
	readonly global?: GlobalAccessor;
	readonly declaration: CFunction;
	readonly gaps: ReadonlyArray<Gap>;
}

export interface GlobalAccessor {
	readonly declaration: CGlobal;
	readonly access: "get" | "set";
	readonly bounded?: { readonly format: "string" | "bytes" };
	readonly synchronizedCount?: true;
	readonly retained?: {
		readonly format: "string" | "bytes";
		readonly count?: {
			readonly declaration: CGlobal;
			readonly bits: number;
			readonly signed: boolean;
		};
	};
}

export interface MappedField {
	readonly name: string;
	readonly type: CType;
	readonly value: JsResult;
	readonly bitWidth?: number;
	readonly doc?: FfiText;
}

export interface ManagedField {
	readonly kind: "bytes" | "string";
	readonly name: string;
	readonly type: CType;
	readonly count: string;
	readonly countType: CType;
	readonly bits: number;
	readonly signed: boolean;
	readonly writable: boolean;
	readonly doc?: FfiText;
}

export interface MappedRecord {
	/** The type name generated declarations use. */
	readonly name: string;
	/** How C code spells the type: a typedef name or `struct tag`. */
	readonly spelling: string;
	readonly record: CRecord;
	readonly fields: ReadonlyArray<MappedField>;
	readonly private?: true;
}

export interface MappedUnion {
	readonly name: string;
	readonly spelling: string;
	readonly record: CRecord;
	readonly member: MappedField;
	readonly alias?: string;
}

export interface MappedTagged {
	readonly name: string;
	readonly spelling: string;
	readonly record: CRecord;
	readonly tag: MappedField;
	readonly cases: ReadonlyArray<{
		readonly expression: string;
		readonly initializeTag: boolean;
		readonly literal: string;
		readonly selection: ReadonlyArray<string>;
		readonly record: MappedRecord;
	}>;
	readonly alias?: string;
}

/** A type whose values are handles, as the contract's facts and the headers define it. */
export interface HandleType {
	/** The struct the handle wraps, which also names its JavaScript type. */
	readonly name: string;
	/** How C code spells the struct type. */
	readonly spelling: string;
	/** A copy of a struct the library passes by value, or a pointer it returns. */
	readonly representation: "struct" | "pointer";
	/** Directed pointer compatibility, including transitive views. */
	readonly views: ReadonlyArray<string>;
	/** Canonical identity shared by connected pointer views. */
	readonly family: string;
	/** A factory named by the type fact, allocating stable caller-owned storage. */
	readonly allocator?: string;
	/** The trailing array whose element count the caller factory accepts. */
	readonly trailing?: string;
	readonly layout?: { readonly size: string; readonly alignment: string };
	readonly destroy?: {
		readonly name: string;
		readonly success?: string;
		/** Whether the destroy function takes the struct by value or by address. */
		readonly takes: "value" | "pointer";
	};
	readonly collect: boolean;
	/** Read-only value fields and explicitly declared callable fields. */
	readonly fields: ReadonlyArray<MappedField>;
	readonly managedFields: ReadonlyArray<ManagedField>;
	readonly doc?: FfiText;
}

export interface MappedConstant {
	readonly name: string;
	readonly source: "enum" | "macro";
	readonly type: CType;
	readonly value: JsResult;
	/** Known at build time; otherwise the binding reads the C expression when it loads. */
	readonly known?: bigint | number | string;
	readonly doc?: FfiText;
}

export interface SkippedConstant {
	readonly name: string;
	readonly reason: string;
}

export interface NativeType {
	readonly name: string;
	readonly sizeBits: number;
	readonly alignmentBits: number;
	readonly doc?: FfiText;
}

export interface BoundDispatcher {
	readonly name: string;
	readonly declaration: CFunction;
	readonly cases: ReadonlyArray<BoundFunction>;
}

export interface BindingPlan {
	readonly functions: ReadonlyArray<BoundFunction>;
	readonly dispatchers: ReadonlyArray<BoundDispatcher>;
	/**
	 * A shared C dependency can invoke a callback while a different binding runs,
	 * including a call nested inside a call-scoped callback.
	 */
	readonly hasCallbacks: boolean;
	readonly unbound: ReadonlyArray<UnboundFunction>;
	readonly records: ReadonlyMap<string, MappedRecord>;
	readonly unions: ReadonlyMap<string, MappedUnion>;
	readonly tagged: ReadonlyMap<string, MappedTagged>;
	readonly natives: ReadonlyMap<string, NativeType>;
	readonly handles: ReadonlyMap<string, HandleType>;
	readonly constants: ReadonlyArray<MappedConstant>;
	readonly skippedConstants: ReadonlyArray<SkippedConstant>;
}

type ResultShapes = Pick<BindingPlan, "records"> & {
	readonly handles: ReadonlyMap<string, Pick<HandleType, "representation" | "destroy">>;
};

export function hasResultHandles(value: JsResult, shapes: ResultShapes): boolean {
	switch (value.kind) {
		case "handle":
			return (
				shapes.handles.get(value.name)!.representation === "pointer" &&
				independentHandle(value)
			);
		case "record":
			return shapes.records
				.get(value.name)!
				.fields.some((field) => hasResultHandles(field.value, shapes));
		case "tagged":
			return value.cases.some((entry) => hasResultHandles(entry.value, shapes));
		case "array":
		case "sequence":
		case "union":
			return hasResultHandles(value.of, shapes);
		default:
			return false;
	}
}

export function hasOwnedRecordFields(
	value: JsValue,
	shapes: Pick<BindingPlan, "records">,
): boolean {
	const field = (entry: MappedField): boolean =>
		(entry.value.kind === "handle" && entry.value.ownership.kind === "owned") ||
		hasOwnedRecordFields(entry.value, shapes);
	switch (value.kind) {
		case "record":
			return shapes.records.get(value.name)!.fields.some(field);
		case "tagged":
			return value.cases.some((entry) => hasOwnedRecordFields(entry.value, shapes));
		case "array":
		case "sequence":
		case "union":
			return hasOwnedRecordFields(value.of, shapes);
		default:
			return false;
	}
}

export function supportsResultTransaction(
	value: JsResult,
	shapes: ResultShapes,
	context: "direct" | "record" | "other" = "direct",
): boolean {
	switch (value.kind) {
		case "handle":
			return (
				context !== "other" &&
				shapes.handles.get(value.name)!.representation === "pointer" &&
				independentHandle(value)
			);
		case "callable":
			return false;
		case "record":
			return shapes.records
				.get(value.name)!
				.fields.every((field) =>
					supportsResultTransaction(
						field.value,
						shapes,
						context === "other" ? "other" : "record",
					),
				);
		case "sequence":
			if (value.of.kind === "handle")
				return (
					context === "direct" &&
					independentHandle(value.of) &&
					shapes.handles.get(value.of.name)!.representation === "pointer"
				);
			return supportsResultTransaction(
				value.of,
				shapes,
				hasOwnedRecordFields(value.of, shapes) ? context : "other",
			);
		case "array":
			return supportsResultTransaction(
				value.of,
				shapes,
				hasOwnedRecordFields(value.of, shapes) ? context : "other",
			);
		case "union":
			return supportsResultTransaction(value.of, shapes, context);
		case "tagged":
			return value.cases.every((entry) =>
				supportsResultTransaction(entry.value, shapes, context),
			);
		default:
			return true;
	}
}

type Position = "param" | "return" | "field" | "constant";

/** A fixed array of `element` values, in the direction `position` gives it. */
function arrayOf(
	element: JsValue,
	position: Position,
	length: number,
	format?: "string" | "bytes",
): JsValue {
	const shape = {
		kind: "array",
		length,
		...(format === undefined ? {} : { format }),
	} as const;
	return position === "param"
		? { ...shape, of: inputOf(element) }
		: { ...shape, of: resultOf(element) };
}

/** How C code spells a struct: `struct tag`, or the typedef that names an unnamed one. */
function recordSpelling(model: CModel, record: CRecord): string {
	if (record.named) return `${record.tag} ${record.name}`;
	const typedef = [...model.typedefs.values()].find(
		(entry) =>
			entry.type.kind === "record" &&
			entry.type.name === record.name &&
			entry.type.const !== true,
	);
	return typedef?.name ?? record.name;
}

const NO_FACTS: MaligatorFfiValueFacts = {};

function valueCount(
	facts: MaligatorFfiValueFacts,
): { kind: "bytes" | "array" | "string"; count: MaligatorFfiCount } | undefined {
	if (facts.bytes !== undefined) return { kind: "bytes", count: facts.bytes };
	if (facts.array !== undefined) return { kind: "array", count: facts.array };
	if (typeof facts.string === "object") return { kind: "string", count: facts.string };
	return undefined;
}

/** A function's facts by parameter position. */
interface FunctionFacts {
	readonly callsJavaScript?: false;
	readonly params: ReadonlyArray<MaligatorFfiValueFacts | undefined>;
	readonly returns: MaligatorFfiValueFacts;
	readonly initializes?: MaligatorFfiFunctionFacts["initializes"];
}

const EMPTY_FACTS: LibraryFacts = { types: {}, functions: {} };

/** The struct a type fact names: a struct tag, or a typedef of a struct or struct pointer. */
function factRecord(model: CModel, key: string): CRecord | undefined {
	const record = model.records.get(key);
	if (record !== undefined) return record;
	const typedef = model.typedefs.get(key);
	if (typedef === undefined) return undefined;
	let resolved = resolveCType(model, typedef.type);
	if (resolved.kind === "pointer") resolved = resolveCType(model, resolved.to);
	return resolved.kind === "record" ? model.records.get(resolved.name) : undefined;
}

/**
 * Handle types from the contract's facts. A handle copies the struct when the
 * library passes it by value, and otherwise holds the pointer the library returns.
 */
interface ModelIndex {
	readonly functions: ReadonlyMap<string, CFunction>;
	/** Structs some function takes or returns by value. */
	readonly passedByValue: ReadonlySet<string>;
}

const modelIndexes = new WeakMap<CModel, ModelIndex>();

/** Lookups the planner repeats per fact; suggestion validation plans one model repeatedly. */
function modelIndex(model: CModel): ModelIndex {
	const cached = modelIndexes.get(model);
	if (cached !== undefined) return cached;
	const functions = new Map<string, CFunction>();
	const passedByValue = new Set<string>();
	for (const declaration of model.functions) {
		if (!functions.has(declaration.name)) functions.set(declaration.name, declaration);
		for (const type of [
			declaration.returns,
			...declaration.params.map(({ type }) => type),
		]) {
			const resolved = resolveCType(model, type);
			if (resolved.kind === "record") passedByValue.add(resolved.name);
		}
	}
	const index = { functions, passedByValue };
	modelIndexes.set(model, index);
	return index;
}

function handleTypes(
	model: CModel,
	facts: LibraryFacts,
): Map<string, Omit<HandleType, "fields" | "managedFields">> {
	const handles = new Map<string, Omit<HandleType, "fields" | "managedFields">>();
	for (const [key, typeFacts] of Object.entries(facts.types)) {
		const handle = typeFacts.handle;
		if (
			typeFacts.fields !== undefined &&
			handle?.storage !== "caller" &&
			Object.values(typeFacts.fields).some(
				(field) => field.callable === undefined && field.handle === undefined,
			)
		)
			throw new FfiFactError(
				"unmet-requirement",
				`types.${key}.fields`,
				"managed fields require caller storage",
			);
		if (typeFacts.fields !== undefined) {
			const owned = Object.values(typeFacts.fields).every(
				(field) => field.handle?.owned === true,
			);
			if (
				(handle === undefined && !owned) ||
				(handle !== undefined &&
					Object.values(typeFacts.fields).some((field) => field.handle?.owned === true))
			)
				throw new FfiFactError(
					"unmet-requirement",
					`types.${key}.fields`,
					"independent owned fields require a plain value record; borrowed fields require a handle",
				);
		}
		if (handle === undefined) {
			if (!model.typedefs.has(key) && !model.records.has(key) && !model.enums.has(key))
				throw new FfiFactError(
					"unknown-name",
					`types.${key}`,
					`the headers declare no type named '${key}'`,
				);
			continue;
		}
		const record = factRecord(model, key);
		if (record === undefined) {
			throw new FfiFactError(
				"unknown-name",
				`types.${key}`,
				`the headers declare no struct named '${key}'`,
			);
		}
		if (handles.has(record.name)) {
			throw new FfiFactError(
				"conflict",
				`types.${key}`,
				`${record.name} already has a handle fact`,
			);
		}
		if (handle.trailing !== undefined && handle.storage !== "caller")
			throw new FfiFactError(
				"unmet-requirement",
				`types.${key}.handle.trailing`,
				"requires caller storage",
			);
		if (
			handle.layout !== undefined &&
			(handle.storage !== "caller" || handle.trailing !== undefined)
		)
			throw new FfiFactError(
				"unmet-requirement",
				`types.${key}.handle.layout`,
				"requires caller storage without a trailing field",
			);
		if (handle.storage === "caller") {
			if (handle.layout !== undefined) {
				if (record.complete || record.tag !== "struct")
					throw new FfiFactError(
						"unmet-requirement",
						`types.${key}.handle.layout`,
						"queries require an incomplete struct",
					);
				for (const [field, name] of Object.entries(handle.layout)) {
					const query = modelIndex(model).functions.get(name);
					const result =
						query === undefined ? undefined : resolveCType(model, query.returns);
					const bytes =
						result?.kind === "integer" ? model.target.sizes[result.name] : undefined;
					const unsigned =
						result?.kind === "integer" &&
						(result.name === "char"
							? !model.target.charSigned
							: result.name.startsWith("unsigned"));
					if (
						query === undefined ||
						query.params.length !== 0 ||
						query.variadic ||
						!unsigned ||
						bytes === undefined ||
						bytes < 1 ||
						bytes > 8
					)
						throw new FfiFactError(
							"inapplicable",
							`types.${key}.handle.layout.${field}`,
							`'${name}' must take no arguments and return an unsigned integer up to 64 bits`,
						);
				}
			} else if (!record.complete || record.tag !== "struct")
				throw new FfiFactError(
					"unmet-requirement",
					`types.${key}.handle.storage`,
					"caller storage needs a complete struct",
				);
			const variable = record.fields.filter((field) => {
				const type = resolveCType(model, field.type);
				return type.kind === "array" && (type.length === undefined || type.length === 0);
			});
			if (variable.length > 0 && handle.trailing === undefined)
				throw new FfiFactError(
					"unmet-requirement",
					`types.${key}.handle.storage`,
					"variable-length allocation size needs a trailing field fact",
				);
			if (handle.trailing !== undefined) {
				const field = record.fields.at(-1);
				const type = field === undefined ? undefined : resolveCType(model, field.type);
				if (
					field?.name !== handle.trailing ||
					variable.length !== 1 ||
					variable[0] !== field ||
					type?.kind !== "array"
				)
					throw new FfiFactError(
						"unmet-requirement",
						`types.${key}.handle.trailing`,
						"name the final flexible or zero-length array field",
					);
				const complete = (type: CType): boolean => {
					const resolved = resolveCType(model, type);
					if (resolved.kind === "array")
						return (
							resolved.length !== undefined &&
							resolved.length > 0 &&
							complete(resolved.of)
						);
					if (resolved.kind === "record")
						return model.records.get(resolved.name)?.complete === true;
					return !["void", "function", "unsupported", "typedef"].includes(resolved.kind);
				};
				if (!complete(type.of))
					throw new FfiFactError(
						"unmet-requirement",
						`types.${key}.handle.trailing`,
						"array elements need a complete object type",
					);
			}
			if (
				(handle.destroy !== undefined || handle.collect === true) &&
				!(typeof handle.destroy === "string" && handle.collect === true)
			)
				throw new FfiFactError(
					"unmet-requirement",
					`types.${key}.handle.storage`,
					"managed caller cleanup requires an unconditional collecting destructor",
				);
		}
		const isRecord = (type: CType): boolean => {
			const resolved = resolveCType(model, type);
			return resolved.kind === "record" && resolved.name === record.name;
		};
		let destroy: HandleType["destroy"];
		if (handle.destroy !== undefined) {
			const name =
				typeof handle.destroy === "string" ? handle.destroy : handle.destroy.function;
			const success =
				typeof handle.destroy === "string" ? undefined : handle.destroy.success;
			const declaration = modelIndex(model).functions.get(name);
			if (declaration === undefined) {
				throw new FfiFactError(
					"unknown-name",
					`types.${key}.handle.destroy`,
					`the headers declare no function '${name}'`,
				);
			}
			if (success !== undefined) {
				const result = resolveCType(model, declaration.returns);
				if (!["integer", "enum", "bool"].includes(result.kind))
					throw new FfiFactError(
						"inapplicable",
						`types.${key}.handle.destroy.success`,
						`${name} must return an integer or boolean`,
					);
				if (handle.collect === true)
					throw new FfiFactError(
						"unmet-requirement",
						`types.${key}.handle.collect`,
						"cleanup that can fail requires explicit disposal",
					);
				if (/^[A-Za-z_]\w*$/.test(success) && success !== "true" && success !== "false") {
					const macro = model.macros.find((entry) => entry.name === success);
					const knownMacro =
						macro !== undefined &&
						(typeof macro.value === "bigint" ||
							(typeof macro.value === "number" && Number.isInteger(macro.value)));
					if (
						!knownMacro &&
						![...model.enums.values()].some((entry) =>
							entry.constants.some((constant) => constant.name === success),
						)
					)
						throw new FfiFactError(
							"unknown-name",
							`types.${key}.handle.destroy.success`,
							`'${success}' is not a known integer constant`,
						);
				}
			}
			const param = declaration.params[0];
			const resolved = param === undefined ? undefined : resolveCType(model, param.type);
			if (
				declaration.params.length === 1 &&
				param !== undefined &&
				isRecord(param.type)
			) {
				destroy = {
					name: declaration.name,
					takes: "value",
					...(success === undefined ? {} : { success }),
				};
			} else if (
				declaration.params.length === 1 &&
				resolved?.kind === "pointer" &&
				isRecord(resolved.to)
			) {
				destroy = {
					name: declaration.name,
					takes: "pointer",
					...(success === undefined ? {} : { success }),
				};
			} else {
				throw new FfiFactError(
					"inapplicable",
					`types.${key}.handle.destroy`,
					`${declaration.name} must take only a ${record.name}`,
				);
			}
		}
		const passedByValue = modelIndex(model).passedByValue.has(record.name);
		handles.set(record.name, {
			name: record.name,
			spelling: recordSpelling(model, record),
			representation:
				handle.storage !== "caller" && record.complete && passedByValue
					? "struct"
					: "pointer",
			...(handle.storage === "caller" ? { allocator: key } : {}),
			...(handle.trailing === undefined ? {} : { trailing: handle.trailing }),
			...(handle.layout === undefined ? {} : { layout: handle.layout }),
			...(destroy === undefined ? {} : { destroy }),
			collect: handle.collect === true,
			views: [],
			family: record.name,
			...(record.doc === undefined ? {} : { doc: record.doc }),
		});
	}
	for (const [key, factsForType] of Object.entries(facts.types)) {
		if (factsForType.handle?.views === undefined) continue;
		const record = factRecord(model, key)!;
		const handle = handles.get(record.name)!;
		const views: Array<string> = [];
		for (const target of factsForType.handle.views) {
			const name = factRecord(model, target)?.name;
			const view = name === undefined ? undefined : handles.get(name);
			const at = `types.${key}.handle.views`;
			if (view === undefined)
				throw new FfiFactError(
					"unmet-requirement",
					at,
					`'${target}' needs a handle fact`,
				);
			if (handle.representation !== "pointer" || view.representation !== "pointer")
				throw new FfiFactError("inapplicable", at, "views require pointer handles");
			if (view.name === handle.name || views.includes(view.name))
				throw new FfiFactError("conflict", at, `repeated or self view '${target}'`);
			views.push(view.name);
		}
		handles.set(record.name, { ...handle, views });
	}
	const closure = new Map<string, ReadonlyArray<string>>();
	const visiting = new Set<string>();
	const resolveViews = (name: string): ReadonlyArray<string> => {
		const known = closure.get(name);
		if (known !== undefined) return known;
		if (visiting.has(name))
			throw new FfiFactError("conflict", `types.${name}.handle.views`, "cyclic views");
		visiting.add(name);
		const views = new Set<string>();
		for (const view of handles.get(name)!.views) {
			views.add(view);
			for (const ancestor of resolveViews(view)) views.add(ancestor);
		}
		visiting.delete(name);
		const result = [...views].sort();
		closure.set(name, result);
		return result;
	};
	for (const name of handles.keys()) resolveViews(name);
	const neighbors = new Map(
		[...handles].map(([name, handle]) => [name, new Set(handle.views)]),
	);
	for (const [name, handle] of handles)
		for (const view of handle.views) neighbors.get(view)!.add(name);
	const families = new Map<string, string>();
	for (const name of handles.keys()) {
		if (families.has(name)) continue;
		const component = new Set([name]);
		for (const member of component)
			for (const neighbor of neighbors.get(member)!) component.add(neighbor);
		const family = [...component].sort()[0]!;
		for (const member of component) families.set(member, family);
	}
	for (const [name, handle] of handles)
		handles.set(name, {
			...handle,
			views: closure.get(name)!,
			family: families.get(name)!,
		});
	return handles;
}

function functionFacts(model: CModel, facts: LibraryFacts): Map<string, FunctionFacts> {
	const result = new Map<string, FunctionFacts>();
	for (const [name, entry] of Object.entries(facts.functions)) {
		const declaration = modelIndex(model).functions.get(name);
		if (declaration === undefined) {
			throw new FfiFactError(
				"unknown-name",
				`functions.${name}`,
				`the headers declare no function '${name}'`,
			);
		}
		const params = new Array<MaligatorFfiValueFacts | undefined>(
			declaration.params.length,
		);
		for (const [key, valueFacts] of Object.entries(entry.params ?? {})) {
			const index = /^\d+$/.test(key)
				? Number(key) - 1
				: declaration.params.findIndex((param) => param.name === key);
			if (index < 0 || index >= declaration.params.length) {
				throw new FfiFactError(
					"unknown-name",
					`functions.${name}.params.${key}`,
					`${name} has no such parameter`,
				);
			}
			params[index] = valueFacts;
		}
		result.set(name, {
			params,
			...(entry.callsJavaScript === undefined
				? {}
				: { callsJavaScript: entry.callsJavaScript }),
			returns: entry.returns ?? NO_FACTS,
			...(entry.initializes === undefined ? {} : { initializes: entry.initializes }),
		});
	}
	return result;
}

function nativeAlias(
	model: CModel,
	natives: ReadonlyMap<string, NativeType>,
	type: CType,
): NativeType | Gapped | undefined {
	if (natives.size === 0) return undefined;
	const seen = new Set<string>();
	let qualified = false;
	while (type.kind === "typedef" && !seen.has(type.name)) {
		const native = natives.get(type.name);
		if (native !== undefined) {
			if (qualified)
				return {
					gap: `native ${native.name}: const typedef aliases need an explicit value construction interface`,
					code: "unsupported",
				};
			return native;
		}
		seen.add(type.name);
		const next = model.typedefs.get(type.name)?.type;
		if (next === undefined) return undefined;
		if ("const" in next && next.const === true) qualified = true;
		type = next;
	}
	return undefined;
}

function compatibleTagStorage(
	model: CModel,
	source: CField,
	target: CField,
	path: ReadonlyArray<CFieldStep>,
): boolean {
	const left = resolveCType(model, source.integerType ?? source.type);
	const right = resolveCType(model, target.integerType ?? target.type);
	if (path.length === 0) {
		if (source.bitWidth !== target.bitWidth) return false;
		return (
			(left.kind === "bool" && right.kind === "bool") ||
			(left.kind === "integer" && right.kind === "integer" && left.name === right.name)
		);
	}
	if (left.kind !== "record" || right.kind !== "record") return false;
	const leftRecord = model.records.get(left.name),
		rightRecord = model.records.get(right.name);
	const step = path[0]!;
	if (
		leftRecord?.tag !== "struct" ||
		rightRecord?.tag !== "struct" ||
		step.record.name !== leftRecord.name
	)
		return false;
	// A post-construction tag check cannot safely read an incompatible representation.
	// Shared prefixes must also agree on target offsets and bit-field widths.
	for (let index = 0; index <= step.index; index++) {
		const leftField = leftRecord.fields[index],
			rightField = rightRecord.fields[index];
		const offset = leftRecord.layout?.fieldOffsetsBits[index];
		if (
			leftField === undefined ||
			rightField === undefined ||
			offset === undefined ||
			offset !== rightRecord.layout?.fieldOffsetsBits[index] ||
			leftField.bitWidth !== rightField.bitWidth
		)
			return false;
		if (
			index < step.index &&
			formatCDeclaration(resolveCType(model, leftField.type)) !==
				formatCDeclaration(resolveCType(model, rightField.type))
		)
			return false;
	}
	return compatibleTagStorage(
		model,
		step.field,
		rightRecord.fields[step.index]!,
		path.slice(1),
	);
}

class Planner {
	readonly #model: CModel;
	readonly #accesses: ReturnType<typeof cRecordAccesses>;
	readonly records = new Map<string, MappedRecord>();
	readonly unions = new Map<string, MappedUnion>();
	readonly tagged = new Map<string, MappedTagged>();
	readonly natives = new Map<string, NativeType>();
	readonly #shapes = new Map<string, { alias: string; shape: MaligatorFfiShape }>();
	readonly #fields = new Map<string, Readonly<Record<string, MaligatorFfiFieldFacts>>>();
	readonly #handles: ReadonlyMap<string, Omit<HandleType, "fields" | "managedFields">>;
	readonly #recordGaps = new Map<string, Gapped>();
	readonly #pending = new Set<string>();
	#callableCount = 0;
	hasCallableCallbacks = false;

	constructor(
		model: CModel,
		handles: ReadonlyMap<string, Omit<HandleType, "fields" | "managedFields">>,
		facts: LibraryFacts,
	) {
		this.#model = model;
		this.#accesses = cRecordAccesses(model);
		this.#handles = handles;
		for (const [name, entry] of Object.entries(facts.types)) {
			if (entry.fields !== undefined && entry.handle === undefined) {
				const record = factRecord(model, name);
				if (
					record?.tag !== "struct" ||
					!record.complete ||
					handles.has(record.name) ||
					entry.shape !== undefined
				)
					throw new FfiFactError(
						"unmet-requirement",
						`types.${name}.fields`,
						"independent ownership requires a complete plain struct",
					);
				if (this.#fields.has(record.name))
					throw new FfiFactError(
						"conflict",
						`types.${name}.fields`,
						"this record already has field facts",
					);
				const members = [...promotedCFields(model, record)];
				for (const field of Object.keys(entry.fields))
					if (!members.some((member) => member.name === field))
						throw new FfiFactError(
							"unknown-name",
							`types.${name}.fields.${field}`,
							"the record has no such field",
						);
				this.#fields.set(record.name, entry.fields);
			}
			if (entry.representation === "native") {
				if (
					entry.handle !== undefined ||
					entry.shape !== undefined ||
					entry.fields !== undefined
				)
					throw new FfiFactError(
						"conflict",
						`types.${name}.representation`,
						"native values cannot declare handle, shape, or fields",
					);
				const alias = model.typedefs.get(name);
				if (alias === undefined)
					throw new FfiFactError(
						"inapplicable",
						`types.${name}.representation`,
						"native values require an arithmetic typedef",
					);
				let type: CType = { kind: "typedef", name };
				const seen = new Set<string>();
				while (type.kind === "typedef") {
					if (seen.has(type.name))
						throw new FfiFactError(
							"unmet-requirement",
							`types.${name}.representation`,
							"recursive typedef",
						);
					seen.add(type.name);
					if (type.name !== name && facts.types[type.name]?.representation === "native")
						throw new FfiFactError(
							"conflict",
							`types.${name}.representation`,
							"the typedef chain already has a native representation",
						);
					if (type.const === true) break;
					const target: CType | undefined = model.typedefs.get(type.name)?.type;
					if (target === undefined) break;
					type = target;
				}
				if (!isCNativeValueType(type) || ("const" in type && type.const === true))
					throw new FfiFactError(
						"inapplicable",
						`types.${name}.representation`,
						"native values require an unqualified arithmetic typedef",
					);
				if (alias.sizeBits === undefined || alias.alignmentBits === undefined)
					throw new FfiFactError(
						"unmet-requirement",
						`types.${name}.representation`,
						"Clang did not identify native storage layout",
					);
				this.natives.set(name, {
					name,
					sizeBits: alias.sizeBits,
					alignmentBits: alias.alignmentBits,
					...(alias.doc === undefined ? {} : { doc: alias.doc }),
				});
			}
			if (entry.shape === undefined) continue;
			const type = model.records.has(name)
				? { kind: "record" as const, tag: model.records.get(name)!.tag, name }
				: model.typedefs.get(name)?.type;
			const resolved = type === undefined ? undefined : resolveCType(model, type);
			if (
				resolved?.kind !== "record" ||
				("member" in entry.shape && resolved.tag !== "union") ||
				entry.handle !== undefined ||
				handles.has(resolved.name)
			)
				throw new FfiFactError(
					"inapplicable",
					`types.${name}.shape`,
					"member selection requires a union value; tagged shapes require a record value",
				);
			if (this.#shapes.has(resolved.name))
				throw new FfiFactError(
					"conflict",
					`types.${name}.shape`,
					"this record already has a shape fact",
				);
			this.#shapes.set(resolved.name, { alias: name, shape: entry.shape });
		}
	}

	#integer(name: string): Mapping<JsResult> {
		const size = this.#model.target.sizes[name];
		if (size === undefined)
			return { gap: `${name} has no size on this target`, code: "unsupported" };
		const signed =
			name === "char" ? this.#model.target.charSigned : !name.startsWith("unsigned");
		const bits = size * 8;
		if (bits <= 32) return { value: { kind: "integer", bits, signed } };
		if (bits === 64) return { value: { kind: "bigint", bits, signed } };
		return {
			gap: `${bits}-bit integers have no JavaScript mapping`,
			code: "unsupported",
		};
	}

	value(
		type: CType,
		position: Position,
		facts: MaligatorFfiValueFacts = NO_FACTS,
	): Mapping {
		if (facts.array?.capacity !== undefined)
			throw new FfiFactError(
				"inapplicable",
				"array.capacity",
				"applies to caller-owned output buffers",
			);
		const resolved = resolveCType(this.#model, type);
		const native = nativeAlias(this.#model, this.natives, type);
		if (native !== undefined) {
			if ("gap" in native) return native;
			if (
				facts.shape !== undefined ||
				facts.array !== undefined ||
				facts.bytes !== undefined ||
				(facts.string !== undefined && facts.string !== false) ||
				facts.free !== undefined ||
				facts.fresh !== undefined
			)
				throw new FfiFactError(
					"inapplicable",
					"",
					`native ${native.name}: value boxes do not use pointer or shape facts`,
				);
			return { value: { kind: "native", name: native.name } };
		}
		if (facts.array?.element !== undefined && resolved.kind !== "pointer")
			throw new FfiFactError(
				"inapplicable",
				"array.element",
				"requires a pointer to fixed character array rows",
			);
		if (
			facts.shape !== undefined &&
			resolved.kind !== "record" &&
			!(resolved.kind === "pointer" && facts.array !== undefined)
		)
			throw new FfiFactError(
				"inapplicable",
				"shape",
				"applies to record values or array elements",
			);
		if (facts.fresh === true) {
			const target =
				resolved.kind === "pointer" ? resolveCType(this.#model, resolved.to) : undefined;
			const handle =
				target?.kind === "record" ? this.#handles.get(target.name) : undefined;
			if (
				position !== "return" ||
				handle?.representation !== "pointer" ||
				facts.array !== undefined ||
				facts.bytes !== undefined ||
				facts.string !== undefined
			)
				throw new FfiFactError(
					"inapplicable",
					"fresh",
					"applies only to pointer handle results",
				);
		}
		switch (resolved.kind) {
			case "void":
				return position === "return"
					? { value: { kind: "undefined" } }
					: { gap: "void is not a value", code: "unsupported" };
			case "bool":
				return { value: { kind: "boolean" } };
			case "integer":
				return this.#integer(resolved.name);
			case "float": {
				const size = this.#model.target.sizes[resolved.name] ?? 0;
				return size > 0 && size <= 8
					? { value: { kind: "float", bits: size * 8 } }
					: {
							gap: `${resolved.name} is wider than a JavaScript number`,
							code: "unsupported",
						};
			}
			case "complex":
			case "vector":
			case "bitint":
				return {
					gap: `${formatCDeclaration(resolved)} needs a native representation fact on a typedef`,
					code: "native",
				};
			case "enum": {
				const declaration = this.#model.enums.get(resolved.name);
				const underlying =
					declaration === undefined
						? undefined
						: resolveCType(this.#model, declaration.underlying);
				return underlying?.kind === "integer"
					? this.#integer(underlying.name)
					: this.#integer("int");
			}
			case "pointer":
				return this.#pointer(resolved, position, facts);
			case "array":
				if (position === "param") {
					return this.#pointer({ kind: "pointer", to: resolved.of }, position, facts);
				}
				return this.#array(resolved, position, facts);
			case "record": {
				const handle = this.#handles.get(resolved.name);
				if (
					facts.shape !== undefined &&
					(("member" in facts.shape && resolved.tag !== "union") || handle !== undefined)
				)
					throw new FfiFactError(
						"inapplicable",
						"shape.member",
						"applies to union values",
					);
				if (handle === undefined) {
					const shape = this.#shapes.get(resolved.name);
					const selected = facts.shape ?? shape?.shape;
					const alias = facts.shape === undefined ? shape?.alias : undefined;
					const mapped =
						selected !== undefined && "tag" in selected
							? this.#tagged(resolved.name, selected, alias)
							: resolved.tag === "union"
								? this.#union(resolved.name, selected, alias)
								: this.#record(resolved.name, resolved.tag);
					if (
						position === "return" &&
						facts.borrowed !== true &&
						"value" in mapped &&
						this.#containsHandle(mapped.value) &&
						!hasOwnedRecordFields(mapped.value, this)
					)
						return {
							gap: "resource-bearing value results require a pointer result interface",
							code: "unsupported",
						};
					return mapped;
				}
				if (handle.representation === "pointer") {
					return {
						gap: `${handle.name} handles are pointers, not structs passed by value`,
						code: "unsupported",
					};
				}
				const record = this.#model.records.get(resolved.name);
				if (
					position !== "return" &&
					position !== "param" &&
					record !== undefined &&
					cRecordHasConstMembers(this.#model, record)
				)
					return {
						gap: `${record.name}: const members cannot be copied by value`,
						code: "unsupported",
					};
				const copy = {
					kind: "handle",
					name: handle.name,
					pass: "copy",
					nullable: false,
				} as const;
				return {
					value:
						position === "param"
							? copy
							: {
									...copy,
									ownership: {
										kind:
											position === "return" && facts.borrowed !== true
												? "owned"
												: "borrowed",
									},
								},
				};
			}
			case "function":
				return { gap: "function types need a callback fact", code: "callback" };
			case "typedef":
			case "unsupported":
				return {
					gap: `unsupported type '${formatCDeclaration(type)}'`,
					code: "unsupported",
				};
		}
	}

	#numericView(type: CType, value: JsValue, writable: boolean): NumericView | undefined {
		const resolved = resolveCType(this.#model, type);
		if (resolved.kind !== "pointer" || value.kind !== "sequence") return undefined;
		const target = resolveCType(this.#model, resolved.to);
		if (("const" in target && target.const === true) === writable) return undefined;
		const element = value.of;
		if (
			element.kind === "float" &&
			target.kind === "float" &&
			(target.name === "float" || target.name === "double")
		) {
			return element.bits === 32
				? "Float32Array"
				: element.bits === 64
					? "Float64Array"
					: undefined;
		}
		if (
			(element.kind !== "integer" && element.kind !== "bigint") ||
			target.kind !== "integer"
		)
			return undefined;
		const views: Partial<Record<number, NumericView>> = element.signed
			? { 8: "Int8Array", 16: "Int16Array", 32: "Int32Array", 64: "BigInt64Array" }
			: { 8: "Uint8Array", 16: "Uint16Array", 32: "Uint32Array", 64: "BigUint64Array" };
		return views[element.bits];
	}

	#canBorrowResult(value: JsValue): boolean {
		return (
			value.kind === "handle" ||
			(value.kind === "sequence" &&
				value.of.kind === "handle" &&
				value.of.pass === "pointer" &&
				this.#handles.get(value.of.name)!.representation === "pointer")
		);
	}

	#pointer(
		type: Extract<CType, { kind: "pointer" }>,
		position: Position,
		facts: MaligatorFfiValueFacts,
	): Mapping {
		const target = resolveCType(this.#model, type.to);
		const spelling = formatCDeclaration(type);
		const byteSized =
			target.kind === "integer" && this.#model.target.sizes[target.name] === 1;
		const free = facts.free === undefined ? {} : { free: facts.free };
		const nullable = position === "return" || facts.nullable === true;
		if (facts.bytes !== undefined) {
			if (!byteSized && target.kind !== "void") {
				throw new FfiFactError(
					"inapplicable",
					"bytes",
					`applies to void and byte pointers, not ${spelling}`,
				);
			}
			if (position !== "param") return { value: { kind: "bytes", nullable, ...free } };
			const writable = !("const" in target && target.const === true);
			return {
				value: { kind: "bytes", nullable, ...(writable ? { writable: true } : {}) },
			};
		}
		if (facts.array !== undefined) {
			const format =
				facts.array.element?.string === true
					? "string"
					: facts.array.element?.bytes === true
						? "bytes"
						: undefined;
			if (format !== undefined && target.kind !== "array")
				throw new FfiFactError(
					"inapplicable",
					"array.element",
					"requires fixed character array rows",
				);
			if (format !== undefined && facts.shape !== undefined)
				throw new FfiFactError(
					"conflict",
					"array.element",
					"character formats cannot use a record shape",
				);
			// Elements of a borrowed array, such as a callback's, stay the library's.
			const elementFacts = {
				...(facts.borrowed === true ? { borrowed: true } : {}),
				...(facts.shape === undefined ? {} : { shape: facts.shape }),
			};
			const elementPosition = position === "param" ? "param" : "return";
			const element =
				target.kind === "array"
					? this.#array(target, elementPosition, elementFacts, format)
					: this.value(type.to, elementPosition, elementFacts);
			if ("gap" in element) return { ...element, gap: `array element: ${element.gap}` };
			if (element.value.kind === "sequence" || element.value.kind === "bytes") {
				return { gap: "arrays of arrays need a fact", code: "array" };
			}
			return {
				value:
					position === "param"
						? { kind: "sequence", of: inputOf(element.value), element: type.to, nullable }
						: {
								kind: "sequence",
								of: resultOf(element.value),
								element: type.to,
								nullable,
								...free,
							},
			};
		}
		const countedString = typeof facts.string === "object";
		if ((facts.string === true || countedString) && !byteSized) {
			throw new FfiFactError(
				"inapplicable",
				"string",
				`applies to char pointers, not ${spelling}`,
			);
		}
		if (
			facts.string === true ||
			countedString ||
			(target.kind === "integer" && target.name === "char" && target.const === true)
		) {
			if (position === "param" || position === "return")
				return {
					value: {
						kind: "string",
						nullable,
						...(countedString ? { counted: true as const } : {}),
						...(position === "return" ? free : {}),
					},
				};
		}
		const handle = target.kind === "record" ? this.#handles.get(target.name) : undefined;
		if (handle !== undefined && (position === "param" || position === "return")) {
			if (handle.representation === "pointer") {
				return {
					value:
						position === "param"
							? {
									kind: "handle",
									name: handle.name,
									pass: "pointer",
									nullable: facts.nullable === true,
								}
							: {
									kind: "handle",
									name: handle.name,
									pass: "pointer",
									nullable: true,
									ownership: { kind: facts.borrowed === true ? "borrowed" : "owned" },
									...(facts.fresh === true ? { fresh: true as const } : {}),
								},
				};
			}
			if (position === "param") {
				return {
					value: {
						kind: "handle",
						name: handle.name,
						pass: "reference",
						nullable: facts.nullable === true,
					},
				};
			}
			return {
				gap: `a pointer into a ${handle.name} handle has no owner`,
				code: "unsupported",
			};
		}
		// The record that holds the field names the fact it needs.
		if (position === "field")
			return { gap: `pointer field (${spelling})`, code: "pointer" };
		if (target.kind === "function") {
			return {
				gap: `function pointer (${spelling}) needs a callback fact`,
				code: "callback",
			};
		}
		if (target.kind === "integer" && target.name === "char") {
			return {
				gap: `${spelling} needs a fact: an output buffer, an owned string, or bytes`,
				code: "text",
			};
		}
		if (target.kind === "record" && !this.#model.records.get(target.name)?.complete) {
			return { gap: `opaque pointer (${spelling}) needs a handle fact`, code: "handle" };
		}
		return {
			gap: `pointer (${spelling}) needs a fact: a handle, buffer, out parameter, or string`,
			code: "pointer",
		};
	}

	#array(
		type: Extract<CType, { kind: "array" }>,
		position: Position,
		facts: MaligatorFfiValueFacts = NO_FACTS,
		format?: "string" | "bytes",
	): Mapping {
		if (type.length === undefined)
			return { gap: "an array without a length needs a fact", code: "array" };
		if (type.length === 0)
			return { gap: "a fixed array needs a positive length", code: "unsupported" };
		const element = resolveCType(this.#model, type.of);
		if (element.kind === "integer" && element.name.endsWith("char")) {
			if (format !== undefined) {
				const mapped = this.value(type.of, position);
				return "gap" in mapped
					? mapped
					: { value: arrayOf(mapped.value, position, type.length, format) };
			}
			return {
				gap: `${formatCDeclaration(type)} needs a fact: a string or bytes`,
				code: "text",
			};
		}
		if (format !== undefined && element.kind !== "array")
			return {
				gap: "array.element requires fixed character array rows",
				code: "unsupported",
			};
		const elementFacts = {
			...(facts.borrowed === true ? { borrowed: true } : {}),
			...(facts.shape === undefined ? {} : { shape: facts.shape }),
		};
		const mapped =
			element.kind === "array"
				? this.#array(element, position, elementFacts, format)
				: this.value(type.of, position, elementFacts);
		return "gap" in mapped
			? { ...mapped, gap: `array element: ${mapped.gap}` }
			: { value: arrayOf(mapped.value, position, type.length) };
	}

	#field(field: CField): Mapping<JsResult> {
		if (field.bitWidth === undefined)
			return resultMapping(this.value(field.integerType ?? field.type, "field"));
		if (resolveCType(this.#model, field.type).kind === "bool" && field.bitWidth === 1)
			return { value: { kind: "boolean" } };
		if (field.integerType === undefined)
			return {
				gap: "cannot determine the bit-field's integer type",
				code: "unsupported",
			};
		if (field.bitWidth > 64)
			return {
				gap: "bit-fields wider than 64 bits have no JavaScript mapping",
				code: "unsupported",
			};
		const name = field.integerType.name;
		return {
			value: {
				kind: field.bitWidth <= 32 ? "integer" : "bigint",
				bits: field.bitWidth,
				signed:
					name === "char" ? this.#model.target.charSigned : !name.startsWith("unsigned"),
			},
		};
	}

	#union(
		name: string,
		shape: Extract<MaligatorFfiShape, { member: string }> | undefined,
		alias?: string,
	): Mapping<JsResult> {
		if (shape === undefined)
			return {
				gap: `union ${name}: select an active member with a shape fact`,
				code: "shape",
			};
		const record = this.#model.records.get(name);
		if (record === undefined || !record.complete)
			return { gap: `union ${name}: incomplete type`, code: "unsupported" };
		const field = [...promotedCFields(this.#model, record)].find(
			(field) => field.name === shape.member,
		);
		if (field === undefined)
			throw new FfiFactError(
				"unknown-name",
				"",
				`union ${name}: no member '${shape.member}'`,
			);
		const identity = createHash("sha256")
			.update(
				JSON.stringify([
					this.#accesses.get(name)?.owner,
					this.#accesses.get(name)?.path,
					shape,
					alias,
				]),
			)
			.digest("hex")
			.slice(0, 16);
		const mappedName = `union_${identity}`;
		if (this.#pending.has(mappedName))
			return { gap: `union ${name}: recursive value shape`, code: "unsupported" };
		this.#pending.add(mappedName);
		let mapped: Mapping<JsResult>;
		try {
			mapped = this.#field(field);
		} finally {
			this.#pending.delete(mappedName);
		}
		if ("gap" in mapped)
			return { ...mapped, gap: `union ${name}.${shape.member}: ${mapped.gap}` };
		if (mapped.value.kind === "handle")
			return {
				gap: `union ${name}: a selected handle needs a pointer interface`,
				code: "unsupported",
			};
		const spelling = this.#accesses.get(name)?.spelling;
		if (spelling === undefined)
			return {
				gap: `union ${name}: the C type has no accessible spelling`,
				code: "unsupported",
			};
		this.unions.set(mappedName, {
			name: mappedName,
			spelling,
			record,
			member: {
				name: shape.member,
				type: field.integerType ?? field.type,
				value: mapped.value,
				...(field.bitWidth === undefined ? {} : { bitWidth: field.bitWidth }),
			},
			...(alias === undefined ? {} : { alias }),
		});
		return {
			value: {
				kind: "union",
				name: mappedName,
				of: mapped.value,
				...(alias === undefined ? {} : { alias }),
			},
		};
	}

	#tagged(
		name: string,
		shape: Extract<MaligatorFfiShape, { tag: string }>,
		alias?: string,
	): Mapping<JsResult> {
		const record = this.#model.records.get(name);
		const access = this.#accesses.get(name);
		if (record === undefined || !record.complete || access?.spelling === undefined)
			return {
				gap: `tagged ${name}: the complete C type needs an accessible spelling`,
				code: "unsupported",
			};
		const identity = createHash("sha256")
			.update(JSON.stringify([access.owner, access.path, shape, alias]))
			.digest("hex")
			.slice(0, 16);
		const mappedName = `tagged_${identity}`;
		const known = this.tagged.get(mappedName);
		const asValue = (mapped: MappedTagged): JsResult => ({
			kind: "tagged",
			name: mapped.name,
			tag: mapped.tag.name,
			cases: mapped.cases.map((entry) => ({
				literal: entry.literal,
				value: { kind: "record", name: entry.record.name },
			})),
			...(mapped.alias === undefined ? {} : { alias: mapped.alias }),
		});
		if (known !== undefined) return { value: asValue(known) };
		if (this.#pending.has(mappedName))
			return { gap: `tagged ${name}: recursive value shape`, code: "unsupported" };
		const tagPath = resolveCFieldPath(this.#model, record, [shape.tag]);
		const tagField = tagPath?.at(-1)?.field;
		if (tagField === undefined)
			throw new FfiFactError(
				"unknown-name",
				"",
				`tagged ${name}: no discriminator '${shape.tag}'`,
			);
		const tagMapping = this.#field(tagField);
		if (
			!("value" in tagMapping) ||
			!["integer", "bigint", "boolean"].includes(tagMapping.value.kind)
		)
			throw new FfiFactError(
				"inapplicable",
				"",
				`tagged ${name}.${shape.tag}: the discriminator must be an integer, enum, or boolean`,
			);
		const tag = tagMapping.value;
		if (tag.kind !== "integer" && tag.kind !== "bigint" && tag.kind !== "boolean")
			throw new Error("invalid tag mapping");
		const bits = tag.kind === "boolean" ? 1 : tag.bits;
		const signed = tag.kind === "boolean" ? false : tag.signed;
		const minimum = signed ? -(1n << BigInt(bits - 1)) : 0n;
		const maximum = (1n << BigInt(bits - Number(signed))) - 1n;
		const seen = new Set<bigint>();
		const cases: Array<MappedTagged["cases"][number]> = [];
		this.#pending.add(mappedName);
		try {
			for (const [key, selection] of Object.entries(shape.cases)) {
				const enumeration = [...this.#model.enums.values()]
					.flatMap((entry) => entry.constants)
					.find((entry) => entry.name === key);
				const definition = [...this.#model.macros, ...this.#model.untypedMacros].find(
					(entry) => entry.name === key,
				);
				const macro = this.#model.macros.find((entry) => entry.name === key);
				const constant =
					definition === undefined
						? enumeration?.value
						: definition.contextual !== true && definition.parameters === undefined
							? macro?.value
							: undefined;
				const value = /^(?:0|-?[1-9]\d*)$/.test(key)
					? BigInt(key)
					: typeof constant === "bigint"
						? constant
						: typeof constant === "number" && Number.isSafeInteger(constant)
							? BigInt(constant)
							: undefined;
				if (value === undefined)
					throw new FfiFactError(
						"unknown-name",
						"",
						`tagged ${name}: '${key}' is not a known integer constant`,
					);
				if (value < minimum || value > maximum)
					throw new FfiFactError(
						"unmet-requirement",
						"",
						`tagged ${name}: '${key}' does not fit the discriminator`,
					);
				if (seen.has(value))
					throw new FfiFactError(
						"conflict",
						"",
						`tagged ${name}: duplicate discriminator value '${key}'`,
					);
				seen.add(value);
				const choices = new Map<string, number>();
				const selected = new Set<string>();
				for (const selector of selection) {
					if (selected.has(selector))
						throw new FfiFactError(
							"conflict",
							"",
							`tagged ${name}: duplicate selection '${selector}'`,
						);
					selected.add(selector);
					const path = resolveCFieldPath(this.#model, record, selector.split("."));
					if (
						path === undefined ||
						!path.some((step) => step.record.tag === "union") ||
						path.at(-1)?.record.tag !== "union"
					)
						throw new FfiFactError(
							"inapplicable",
							"",
							`tagged ${name}: '${selector}' must name an active union member`,
						);
					const route: Array<number> = [];
					for (const step of path) {
						if (step.record.tag === "union") {
							const at = route.join(".");
							const prior = choices.get(at);
							if (prior !== undefined && prior !== step.index)
								throw new FfiFactError(
									"conflict",
									"",
									`tagged ${name}: conflicting union selections in '${key}'`,
								);
							choices.set(at, step.index);
						}
						route.push(step.index);
					}
				}
				let initializeTag = true;
				const route: Array<number> = [];
				for (const [index, step] of tagPath!.entries()) {
					const selected = choices.get(route.join("."));
					if (
						step.record.tag === "union" &&
						selected !== undefined &&
						selected !== step.index
					) {
						initializeTag = false;
						if (
							cRecordHasConstMembers(this.#model, record) &&
							!compatibleTagStorage(
								this.#model,
								step.field,
								step.record.fields[selected]!,
								tagPath!.slice(index + 1),
							)
						)
							return {
								gap: `tagged ${name}: the selected payload does not share compatible discriminator storage`,
								code: "unsupported",
							};
					}
					route.push(step.index);
				}
				const view = this.#caseRecord(
					record,
					[],
					choices,
					tagPath!.map((step) => step.index).join("."),
					`${identity}_${cases.length}`,
				);
				if ("gap" in view) return view;
				if (view.value.kind !== "record")
					throw new Error("tagged case without record view");
				cases.push({
					initializeTag,
					expression:
						value < 0n ? `(-INT64_C(${-value - 1n}) - INT64_C(1))` : `UINT64_C(${value})`,
					literal:
						tag.kind === "bigint"
							? `${value}n`
							: tag.kind === "boolean"
								? String(value !== 0n)
								: String(value),
					selection,
					record: this.records.get(view.value.name)!,
				});
			}
		} finally {
			this.#pending.delete(mappedName);
		}
		const mapped: MappedTagged = {
			name: mappedName,
			spelling: access.spelling,
			record,
			tag: { name: shape.tag, type: tagField.integerType ?? tagField.type, value: tag },
			cases,
			...(alias === undefined ? {} : { alias }),
		};
		this.tagged.set(mappedName, mapped);
		return { value: asValue(mapped) };
	}

	#ownedField(field: CField, record: string): Mapping<JsResult> | undefined {
		const facts =
			field.name === undefined
				? undefined
				: this.#fields.get(record)?.[field.name]?.handle;
		if (facts?.owned !== true) return undefined;
		const mapped = resultMapping(
			this.value(field.type, "return", facts.fresh === true ? { fresh: true } : {}),
		);
		if (
			!("value" in mapped) ||
			mapped.value.kind !== "handle" ||
			mapped.value.pass !== "pointer" ||
			this.#handles.get(mapped.value.name)?.destroy === undefined ||
			this.#handles.get(mapped.value.name)?.allocator !== undefined
		)
			throw new FfiFactError(
				"unmet-requirement",
				`types.${record}.fields.${field.name}.handle`,
				"requires an independently owned pointer resource with a destructor",
			);
		return mapped;
	}

	#caseRecord(
		record: CRecord,
		route: ReadonlyArray<number>,
		choices: ReadonlyMap<string, number>,
		omitted: string,
		identity: string,
	): Mapping<JsResult> {
		const spelling = this.#accesses.get(record.name)?.spelling;
		if (spelling === undefined)
			return {
				gap: `tagged ${record.name}: the C type has no accessible spelling`,
				code: "unsupported",
			};
		const mappedName = `MaligatorFfiCase_${identity}_${route.join("_") || "root"}`;
		const fields: Array<MappedField> = [];
		const append = (
			current: CRecord,
			path: ReadonlyArray<number>,
		): Gapped | undefined => {
			const choice = choices.get(path.join("."));
			for (const [index, field] of current.fields.entries()) {
				if (current.tag === "union" && index !== choice) continue;
				const next = [...path, index];
				if (
					next.join(".") === omitted ||
					(field.name === undefined && field.bitWidth !== undefined)
				)
					continue;
				const type = resolveCType(this.#model, field.type);
				const nested =
					type.kind === "record" ? this.#model.records.get(type.name) : undefined;
				if (field.name === undefined) {
					if (nested === undefined)
						return { gap: "unsupported anonymous member", code: "unsupported" };
					const failure = append(nested, next);
					if (failure !== undefined) return failure;
					continue;
				}
				// The outer discriminator owns these fields; defaults cannot activate omitted storage.
				if (
					current.tag === "struct" &&
					nested?.tag === "union" &&
					!choices.has(next.join("."))
				)
					continue;
				const owned = this.#ownedField(field, record.name);
				const mapped = owned ?? this.#caseField(field, next, choices, omitted, identity);
				if (mapped === undefined) continue;
				if ("gap" in mapped)
					return { ...mapped, gap: `field '${field.name}': ${mapped.gap}` };
				if (mapped.value.kind === "handle" && owned === undefined)
					return {
						gap: `field '${field.name}' needs a pointer interface`,
						code: "unsupported",
					};
				fields.push({
					name: field.name,
					type: field.integerType ?? field.type,
					value: mapped.value,
					...(field.bitWidth === undefined ? {} : { bitWidth: field.bitWidth }),
				});
			}
			return undefined;
		};
		const failure = append(record, route);
		if (failure !== undefined)
			return { ...failure, gap: `tagged ${record.name}: ${failure.gap}` };
		this.records.set(mappedName, {
			name: mappedName,
			spelling,
			record,
			fields,
			private: true,
		});
		return { value: { kind: "record", name: mappedName } };
	}

	#caseField(
		field: CField,
		route: ReadonlyArray<number>,
		choices: ReadonlyMap<string, number>,
		omitted: string,
		identity: string,
	): Mapping<JsResult> | undefined {
		const type = resolveCType(this.#model, field.type);
		const record =
			type.kind === "record" ? this.#model.records.get(type.name) : undefined;
		if (record === undefined) return this.#field(field);
		const prefix = route.join(".");
		const selectedBelow = [...choices.keys()].some(
			(key) => key === prefix || key.startsWith(`${prefix}.`),
		);
		if (this.#handles.has(record.name))
			return selectedBelow
				? {
						gap: `union selectors cannot traverse ${record.name} handles`,
						code: "unsupported",
					}
				: this.#field(field);
		if (this.#shapes.has(record.name) && !selectedBelow) return this.#field(field);
		if (record.tag === "struct")
			return this.#caseRecord(record, route, choices, omitted, identity);
		const selected = choices.get(prefix);
		if (selected === undefined) return undefined;
		const member = record.fields[selected]!;
		if (member.name === undefined)
			return this.#caseRecord(record, route, choices, omitted, identity);
		const mapping = this.#caseField(
			member,
			[...route, selected],
			choices,
			omitted,
			identity,
		);
		if (mapping === undefined)
			return { gap: `union ${record.name}: select its active member`, code: "shape" };
		if ("gap" in mapping) return mapping;
		if (mapping.value.kind === "handle")
			return {
				gap: `union ${record.name}: a selected handle needs a pointer interface`,
				code: "unsupported",
			};
		const spelling = this.#accesses.get(record.name)?.spelling;
		if (spelling === undefined)
			return {
				gap: `union ${record.name}: the C type has no accessible spelling`,
				code: "unsupported",
			};
		const name = `case_union_${identity}_${route.join("_")}`;
		this.unions.set(name, {
			name,
			spelling,
			record,
			member: {
				name: member.name,
				type: member.integerType ?? member.type,
				value: mapping.value,
				...(member.bitWidth === undefined ? {} : { bitWidth: member.bitWidth }),
			},
		});
		return { value: { kind: "union", name, of: mapping.value } };
	}

	#record(name: string, tag: "struct" | "union"): Mapping<JsResult> {
		const access = this.#accesses.get(name);
		const anonymous = !/^[A-Za-z_]\w*$/.test(name);
		const mappedName = anonymous
			? `MaligatorFfiAnonymous_${createHash("sha256")
					.update(JSON.stringify([access?.owner, access?.path]))
					.digest("hex")
					.slice(0, 16)}`
			: name;
		const known = this.records.get(mappedName);
		if (known !== undefined) return { value: { kind: "record", name: mappedName } };
		const failure = this.#recordGaps.get(name);
		if (failure !== undefined) return failure;
		const gap = (reason: string, code: GapCode): Gapped => {
			const missing = { gap: `${tag} ${name}: ${reason}`, code };
			this.#recordGaps.set(name, missing);
			return missing;
		};
		const record = this.#model.records.get(name);
		if (tag === "union" || record?.tag === "union")
			return gap("unions need a fact", "shape");
		if (record === undefined || !record.complete)
			return gap("opaque structs cannot pass by value", "unsupported");
		if (access?.spelling === undefined)
			return gap("the C type has no accessible spelling", "unsupported");
		if (this.#pending.has(name)) return gap("recursive struct", "unsupported");
		this.#pending.add(name);
		const fields: Array<MappedField> = [];
		try {
			for (const field of promotedCFields(this.#model, record)) {
				if (field.name === undefined && field.bitWidth !== undefined) continue;
				if (field.name === undefined)
					return gap("anonymous members need a fact", "unsupported");
				const facts = this.#fields.get(name)?.[field.name]?.handle;
				const mapped = this.#ownedField(field, name) ?? this.#field(field);
				if ("gap" in mapped) {
					// A struct that holds a pointer owns or borrows memory, so it crosses as a handle.
					return resolveCType(this.#model, field.type).kind === "pointer"
						? gap(
								`field '${field.name}' is a pointer (${formatCDeclaration(field.type)}), so ${name} needs a handle fact`,
								"handle",
							)
						: gap(`field '${field.name}': ${mapped.gap}`, mapped.code);
				}
				if (mapped.value.kind === "handle" && facts?.owned !== true) {
					return gap(
						`field '${field.name}' holds a ${mapped.value.name} handle, so ${name} needs a handle fact too`,
						"handle",
					);
				}
				fields.push({
					name: field.name,
					type: field.integerType ?? field.type,
					value: mapped.value,
					...(field.bitWidth === undefined ? {} : { bitWidth: field.bitWidth }),
					...(field.doc === undefined ? {} : { doc: field.doc }),
				});
			}
		} finally {
			this.#pending.delete(name);
		}
		this.records.set(mappedName, {
			name: mappedName,
			spelling: access.spelling,
			record,
			fields,
			...(anonymous ? { private: true as const } : {}),
		});
		return { value: { kind: "record", name: mappedName } };
	}

	/** The value fields a struct handle exposes; others stay hidden behind the handle. */
	handleFields(
		record: CRecord,
		managed: ReadonlyArray<ManagedField>,
		handle: Omit<HandleType, "fields" | "managedFields">,
		facts: Readonly<Record<string, MaligatorFfiFieldFacts>>,
		exposeValues: boolean,
	): Array<MappedField> {
		const fields: Array<MappedField> = [];
		const members = [...promotedCFields(this.#model, record)];
		for (const name of Object.keys(facts))
			if (!members.some((field) => field.name === name))
				throw new FfiFactError(
					"unknown-name",
					`types.${record.name}.fields.${name}`,
					"the handle has no such field",
				);
		for (const field of members) {
			if (field.name === undefined || managed.some((entry) => entry.name === field.name))
				continue;
			const fact = facts[field.name];
			if (!exposeValues && fact?.callable === undefined && fact?.handle === undefined)
				continue;
			let mapped: Mapping<JsResult> =
				fact?.callable === undefined
					? this.#field(field)
					: this.#callable(
							field.type,
							{ callable: fact.callable },
							{
								targetType: `__typeof__((0, ((${handle.spelling} *) nullptr)->${field.name}))`,
								path: `types.${record.name}.fields.${field.name}`,
								site: `${record.name}.${field.name}`,
								location: record.location,
								owner: handle.name,
							},
						);
			if (fact?.handle !== undefined) {
				const at = `types.${record.name}.fields.${field.name}.handle`;
				mapped = resultMapping(this.value(field.type, "return", { borrowed: true }));
				if (
					!("value" in mapped) ||
					mapped.value.kind !== "handle" ||
					mapped.value.pass !== "pointer"
				)
					throw new FfiFactError(
						"inapplicable",
						at,
						"requires a pointer-represented resource handle",
					);
				if (this.#handles.get(mapped.value.name)?.allocator !== undefined)
					throw new FfiFactError(
						"unmet-requirement",
						at,
						"requires library-owned resource storage",
					);
				if (fact.handle.lifetime === "owner") {
					if (
						handle.allocator !== undefined &&
						!(
							handle.destroy !== undefined &&
							handle.collect &&
							handle.destroy.success === undefined
						)
					)
						throw new FfiFactError(
							"unmet-requirement",
							at,
							"owner lifetime requires library-owned parent storage",
						);
					mapped = {
						value: { ...mapped.value, ownership: { kind: "owner", owner: handle.name } },
					};
				} else mapped = { value: { ...mapped.value, ownership: { kind: "library" } } };
			}
			if (fact?.callable !== undefined && "gap" in mapped)
				throw new FfiFactError(
					"unmet-requirement",
					`types.${record.name}.fields.${field.name}`,
					`${mapped.gap}`,
				);
			// Accessors return single values; array fields stay behind the handle.
			if (
				"value" in mapped &&
				mapped.value.kind !== "array" &&
				(fact?.handle !== undefined || !this.#containsHandle(mapped.value))
			) {
				fields.push({
					name: field.name,
					type: field.integerType ?? field.type,
					value: mapped.value,
					...(field.bitWidth === undefined ? {} : { bitWidth: field.bitWidth }),
					...(field.doc === undefined ? {} : { doc: field.doc }),
				});
			}
		}
		return fields;
	}

	managedFields(
		record: CRecord,
		facts: Record<string, MaligatorFfiFieldFacts> = {},
	): Array<ManagedField> {
		const result: Array<ManagedField> = [];
		const counts = new Set<string>();
		const fields = [...promotedCFields(this.#model, record)];
		for (const [name, fact] of Object.entries(facts)) {
			if (fact.callable !== undefined || fact.handle !== undefined) continue;
			const at = `types.${record.name}.fields.${name}`;
			const kind = fact.string === undefined ? "bytes" : "string";
			const counted = fact.string ?? fact.bytes;
			const field = fields.find((entry) => entry.name === name);
			const count = fields.find((entry) => entry.name === counted.length);
			const pointer =
				field === undefined ? undefined : resolveCType(this.#model, field.type);
			const integer =
				count === undefined ? undefined : resolveCType(this.#model, count.type);
			const target =
				pointer?.kind === "pointer" ? resolveCType(this.#model, pointer.to) : undefined;
			if (
				field === undefined ||
				pointer?.kind !== "pointer" ||
				pointer.const === true ||
				(!(kind === "bytes" && target?.kind === "void") &&
					!(target?.kind === "integer" && this.#model.target.sizes[target.name] === 1))
			)
				throw new FfiFactError(
					"unmet-requirement",
					at,
					`${kind} requires a writable ${kind === "bytes" ? "byte or void" : "byte"} pointer field`,
				);
			if (
				count === undefined ||
				integer?.kind !== "integer" ||
				integer.const === true ||
				count.bitWidth !== undefined
			)
				throw new FfiFactError(
					"inapplicable",
					`${at}.${kind}.length`,
					`'${counted.length}' must be a writable integer field`,
				);
			if (counts.has(counted.length))
				throw new FfiFactError(
					"conflict",
					`${at}.${kind}.length`,
					`'${counted.length}' already counts another field`,
				);
			const mapped = this.#integer(integer.name);
			if (
				!("value" in mapped) ||
				(mapped.value.kind !== "integer" && mapped.value.kind !== "bigint")
			)
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.${kind}.length`,
					"unsupported integer width",
				);
			counts.add(counted.length);
			result.push({
				kind,
				name,
				type: field.type,
				count: counted.length,
				countType: count.type,
				bits: mapped.value.bits,
				signed: mapped.value.signed,
				writable:
					fact.bytes?.writable ??
					!(target !== undefined && "const" in target && target.const === true),
				...(field.doc === undefined ? {} : { doc: field.doc }),
			});
		}
		return result;
	}

	/**
	 * A callback parameter: C passes each argument to the JavaScript function as it
	 * would a result, except handles, which the library keeps owning.
	 */
	#containsHandle(value: JsValue): boolean {
		if (value.kind === "handle") return true;
		if (value.kind === "tagged")
			return value.cases.some((entry) => this.#containsHandle(entry.value));
		if (value.kind === "array" || value.kind === "sequence" || value.kind === "union")
			return this.#containsHandle(value.of);
		return (
			value.kind === "record" &&
			this.records
				.get(value.name)!
				.fields.some((field) => this.#containsHandle(field.value))
		);
	}

	#notificationElement(value: JsValue): boolean {
		switch (value.kind) {
			case "boolean":
			case "integer":
			case "float":
			case "bigint":
			case "native":
				return true;
			case "string":
				return value.counted !== true;
			case "array":
			case "union":
				return this.#notificationElement(value.of);
			case "record":
				return this.records
					.get(value.name)!
					.fields.every((field) => this.#notificationElement(field.value));
			case "tagged":
				return value.cases.every((entry) => this.#notificationElement(entry.value));
			default:
				return false;
		}
	}

	#callback(
		type: CType,
		nullable: boolean,
		callback: MaligatorFfiCallback,
		at: string,
	): Mapping<CallbackValue> {
		const facts = callback.params ?? {};
		const lifetimes = [
			...(callback.release === undefined ? [] : ["release"]),
			...(callback.replaced === true ? ["replaced"] : []),
			...(callback.closes === undefined ? [] : ["closes"]),
		];
		if (lifetimes.length > 1)
			throw new FfiFactError(
				"conflict",
				`${at}.callback`,
				`${lifetimes.join(" and ")} are alternative lifetimes`,
			);
		const kept = lifetimes.length > 0;
		const queued =
			callback.queued === true ||
			callback.queued === "wait" ||
			callback.closes !== undefined;
		// Whether the callback receives its user data as a `void *` parameter.
		const routed = callback.data !== undefined && callback.lookup === undefined;
		const target =
			type.kind === "pointer" ? resolveCType(this.#model, type.to) : undefined;
		if (target?.kind !== "function" || target.variadic) {
			throw new FfiFactError(
				"inapplicable",
				`${at}.callback`,
				`${formatCDeclaration(type)} is not a function pointer`,
			);
		}
		const factsAt = (index: number): MaligatorFfiValueFacts | undefined =>
			facts[String(index + 1)];
		const resultFacts = callback.returns;
		if (resultFacts !== undefined && callback.closes !== undefined)
			throw new FfiFactError(
				"conflict",
				`${at}.callback.returns`,
				"a close completion ends its registration before returning a pointer result",
			);
		if (resultFacts?.lifetime === "call" && kept)
			throw new FfiFactError(
				"conflict",
				`${at}.callback.returns`,
				"call lifetime needs a call-scoped callback",
			);
		if (resultFacts?.lifetime === "registration" && !kept)
			throw new FfiFactError(
				"conflict",
				`${at}.callback.returns`,
				"registration lifetime needs a retained callback",
			);
		const resultCounted = resultFacts === undefined ? undefined : valueCount(resultFacts);
		let resultCount: Extract<JsValue, { kind: "callback" }>["resultCount"];
		if (resultCounted !== undefined) {
			const reference = resultCounted.count.length;
			const param = /^[1-9]\d*$/.test(reference) ? Number(reference) - 1 : -1;
			const type =
				param < 0 || param >= target.params.length
					? undefined
					: resolveCType(this.#model, target.params[param]!);
			const integer =
				type?.kind === "pointer" ? resolveCType(this.#model, type.to) : undefined;
			const mapped =
				integer?.kind === "integer" ? this.#integer(integer.name) : undefined;
			if (
				integer?.kind !== "integer" ||
				integer.const === true ||
				mapped === undefined ||
				!("value" in mapped) ||
				(mapped.value.kind !== "integer" && mapped.value.kind !== "bigint")
			)
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.callback.returns`,
					"length needs a writable supported integer pointer by 1-based position",
				);
			resultCount = { param, bits: mapped.value.bits, signed: mapped.value.signed };
		}
		for (const key of Object.keys(facts)) {
			const position = Number(key) - 1;
			const stated = facts[key]!;
			if (position >= target.params.length) {
				throw new FfiFactError(
					"unknown-name",
					`${at}.callback.params.${key}`,
					"the callback has no such parameter",
				);
			}
			const unsupported = Object.keys(stated).filter(
				(name) => !["string", "bytes", "array", "nullable", "shape"].includes(name),
			);
			if (unsupported.length > 0) {
				throw new FfiFactError(
					"inapplicable",
					`${at}.callback.params.${key}`,
					`${unsupported.join(", ")} does not apply to callback parameters`,
				);
			}
		}
		// Counts belong to their converted argument and stay hidden from JavaScript.
		const counts = new Array<number | undefined>(target.params.length);
		const counters = new Set<number>();
		target.params.forEach((_, index) => {
			const counted = valueCount(factsAt(index) ?? NO_FACTS)?.count;
			if (counted === undefined) return;
			const count = /^[1-9]\d*$/.test(counted.length) ? Number(counted.length) - 1 : -1;
			const countType =
				count < 0 || count >= target.params.length
					? undefined
					: resolveCType(this.#model, target.params[count]!);
			if (countType?.kind === "integer" && "gap" in this.#integer(countType.name))
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.callback.params.${String(index + 1)}`,
					"a callback count needs a supported integer of at most 64 bits",
				);
			if (countType?.kind !== "integer" || count === index || counters.has(count)) {
				throw new FfiFactError(
					"inapplicable",
					`${at}.callback.params.${String(index + 1)}`,
					`length '${counted.length}' is not another integer parameter's 1-based position`,
				);
			}
			counts[index] = count;
			counters.add(count);
		});
		if (resultCount !== undefined && counters.has(resultCount.param))
			throw new FfiFactError(
				"conflict",
				`${at}.callback.returns`,
				"the result count already counts an argument",
			);
		const params: Array<JsResult | "data" | "count"> = [];
		for (const [index, param] of target.params.entries()) {
			if (counters.has(index) || resultCount?.param === index) {
				params.push("count");
				continue;
			}
			const stated = factsAt(index);
			const resolved = resolveCType(this.#model, param);
			if (
				routed &&
				stated === undefined &&
				resolved.kind === "pointer" &&
				resolveCType(this.#model, resolved.to).kind === "void" &&
				!params.includes("data")
			) {
				params.push("data");
				continue;
			}
			const mapped = resultMapping(
				this.value(param, "return", { ...stated, borrowed: true }),
			);
			if ("gap" in mapped) {
				return {
					...mapped,
					gap: `callback parameter ${String(index + 1)}: ${mapped.gap}`,
				};
			}
			params.push(mapped.value);
		}
		if (routed && !params.includes("data")) {
			throw new FfiFactError(
				"inapplicable",
				`${at}.callback`,
				"the callback takes no void * for its data",
			);
		}
		const lookup =
			callback.lookup === undefined
				? undefined
				: this.#lookup(target, callback.lookup, `${at}.callback.lookup`);
		if (queued) {
			if (
				callback.queued !== "wait" &&
				params.some(
					(param) =>
						typeof param === "object" &&
						this.#containsHandle(param) &&
						!(callback.closes !== undefined && param.kind === "handle"),
				)
			)
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.callback.queued`,
					"resource-bearing values require a waiting callback",
				);
			if (
				callback.queued !== "wait" &&
				params.some(
					(param) =>
						typeof param === "object" &&
						param.kind === "sequence" &&
						!this.#notificationElement(param.of),
				)
			)
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.callback.queued`,
					"notification arrays need value elements or terminated strings",
				);
			// A queued call outlives the C caller's arguments, so it gets copies of values.
			const copyable = params.every(
				(param) =>
					typeof param !== "object" ||
					[
						"boolean",
						"integer",
						"float",
						"bigint",
						"native",
						"string",
						"bytes",
						"record",
						"union",
						"tagged",
						"sequence",
						...(callback.closes !== undefined || callback.queued === "wait"
							? ["handle"]
							: []),
					].includes(param.kind),
			);
			if (
				(callback.queued !== "wait" &&
					resolveCType(this.#model, target.returns).kind !== "void") ||
				!copyable ||
				(lookup !== undefined && callback.closes === undefined)
			) {
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.callback.queued`,
					"a queued callback returns nothing, takes values, strings, buffers, and structs, and has no lookup",
				);
			}
		}
		const returned = resolveCType(this.#model, target.returns);
		let returns: JsInput = { kind: "undefined" };
		if (returned.kind !== "void") {
			const mapped = inputMapping(this.value(target.returns, "param", resultFacts));
			if ("gap" in mapped) return { ...mapped, gap: `callback result: ${mapped.gap}` };
			if (mapped.value.kind !== "handle" && this.#containsHandle(mapped.value))
				return {
					gap: "compound callback results containing handles require a pointer result interface",
					code: "unsupported",
				};
			if (mapped.value.kind === "handle") {
				if (mapped.value.pass !== "pointer")
					return {
						gap: "a callback handle result needs a pointer representation",
						code: "unsupported",
					};
			}
			if (
				(mapped.value.kind === "string" ||
					mapped.value.kind === "bytes" ||
					mapped.value.kind === "handle") &&
				resultFacts?.lifetime === undefined
			) {
				return {
					gap: "a callback that returns a pointer needs a lifetime fact",
					code: "lifetime",
				};
			}
			if (
				resultFacts?.lifetime !== undefined &&
				mapped.value.kind !== "string" &&
				mapped.value.kind !== "bytes" &&
				mapped.value.kind !== "handle"
			)
				throw new FfiFactError(
					"inapplicable",
					`${at}.callback.returns`,
					"lifetime applies to pointer results",
				);
			returns = mapped.value;
		} else if (resultFacts !== undefined)
			throw new FfiFactError(
				"inapplicable",
				`${at}.callback.returns`,
				"lifetime applies to pointer results",
			);
		return {
			value: {
				kind: "callback",
				type: target,
				params,
				counts,
				returns,
				...(resultFacts?.lifetime === undefined
					? {}
					: { returnLifetime: resultFacts.lifetime }),
				...(resultCount === undefined ? {} : { resultCount }),
				nullable,
				// The function resolves a setter's key, a completion, and an owner root.
				lifetime:
					callback.release !== undefined
						? { kind: "released" }
						: callback.replaced === true
							? { kind: "replaced" }
							: { kind: "call" },
				route: routed
					? { kind: "data", param: params.indexOf("data") }
					: lookup !== undefined
						? { kind: "lookup", ...lookup }
						: callback.replaced === true || callback.closes !== undefined
							? { kind: "key" }
							: { kind: "scope" },
				...(queued ? { thread: callback.queued === "wait" ? "wait" : "queue" } : {}),
			},
		};
	}

	/**
	 * Check that a lookup names a function that takes the callback parameter at
	 * `param` and returns `void *`.
	 */
	#lookup(
		callback: Extract<CType, { kind: "function" }>,
		lookup: { readonly function: string; readonly param: string },
		at: string,
	): { readonly function: string; readonly param: number } {
		const declaration = modelIndex(this.#model).functions.get(lookup.function);
		const param = Number(lookup.param) - 1;
		const takes = declaration?.params[0]?.type;
		const passed = callback.params[param];
		const result =
			declaration === undefined
				? undefined
				: resolveCType(this.#model, declaration.returns);
		// A `const` pointee on either side converts implicitly in C.
		const spelling = (type: CType): string =>
			formatCDeclaration(resolveCType(this.#model, type)).replaceAll("const ", "");
		if (
			declaration?.params.length !== 1 ||
			takes === undefined ||
			passed === undefined ||
			result?.kind !== "pointer" ||
			resolveCType(this.#model, result.to).kind !== "void" ||
			spelling(takes) !== spelling(passed)
		) {
			throw new FfiFactError(
				"inapplicable",
				at,
				`'${lookup.function}' does not return a void * from callback parameter ${lookup.param}`,
			);
		}
		return { function: lookup.function, param };
	}

	/**
	 * Key a function's replaced callback by the handle its first parameter passes, so
	 * each handle keeps its own, and without user data find the callback parameter that
	 * passes the handle back. Returns the callback's C parameter position.
	 */
	#replaced(
		declaration: CFunction,
		factsAt: (index: number) => MaligatorFfiValueFacts,
		args: ReadonlyArray<Argument>,
		params: Array<MappedParameter>,
		where: (at: string) => string,
	): number | undefined {
		const indexes = declaration.params.flatMap((_, index) =>
			factsAt(index).callback?.replaced === true ? [index] : [],
		);
		const index = indexes[0];
		if (index === undefined) return undefined;
		const at = where(
			`params.${declaration.params[index]!.name ?? String(index + 1)}.callback`,
		);
		if (indexes.length > 1) {
			throw new FfiFactError(
				"conflict",
				at,
				"a function takes at most one replaced callback",
			);
		}
		const entry = args[index];
		if (entry?.kind !== "input") return index;
		const param = params[entry.param]!;
		if (param.value.kind !== "callback") return index;
		const first = args[0];
		const handle = first?.kind === "input" ? params[first.param]!.value : undefined;
		const key =
			index > 0 && handle?.kind === "handle" && handle.pass === "pointer"
				? handle
				: undefined;
		const keyParam = param.value.params.findIndex(
			(value) =>
				typeof value === "object" &&
				value.kind === "handle" &&
				key !== undefined &&
				this.#handles.get(value.name)?.family === this.#handles.get(key.name)?.family,
		);
		if (key !== undefined && keyParam < 0 && param.value.route.kind === "key") {
			throw new FfiFactError(
				"unmet-requirement",
				at,
				`a replaced callback without data needs a parameter that passes its ${key.name} back`,
			);
		}
		params[entry.param] = {
			...param,
			value: {
				...param.value,
				lifetime: { kind: "replaced", ...(key === undefined ? {} : { key: 0 }) },
				...(param.value.route.kind === "key" && key !== undefined
					? { route: { kind: "key", param: keyParam } }
					: {}),
			},
		};
		return index;
	}

	#closingCallback(
		declaration: CFunction,
		factsAt: (index: number) => MaligatorFfiValueFacts,
		args: ReadonlyArray<Argument>,
		params: Array<MappedParameter>,
		where: (at: string) => string,
	): void {
		const indexes = declaration.params.flatMap((_, index) =>
			factsAt(index).callback?.closes === undefined ? [] : [index],
		);
		if (indexes.length === 0) return;
		if (indexes.length > 1)
			throw new FfiFactError(
				"conflict",
				where("params"),
				"a function takes at most one close completion",
			);
		const index = indexes[0]!;
		const at = where(
			`params.${declaration.params[index]!.name ?? String(index + 1)}.callback.closes`,
		);
		const reference = factsAt(index).callback!.closes!;
		const key = declaration.params.findIndex(
			(param, position) => param.name === reference || String(position + 1) === reference,
		);
		const input = args[key];
		const handle = input?.kind === "input" ? params[input.param]!.value : undefined;
		const entry = args[index];
		if (entry?.kind !== "input") return;
		const param = params[entry.param]!;
		if (param.value.kind !== "callback") return;
		if (
			input?.kind !== "input" ||
			handle?.kind !== "handle" ||
			handle.pass !== "pointer" ||
			handle.nullable ||
			param.value.nullable
		)
			throw new FfiFactError(
				"unmet-requirement",
				at,
				"a close completion needs a nonnullable pointer handle input and callback",
			);
		if (resolveCType(this.#model, declaration.returns).kind !== "void")
			throw new FfiFactError(
				"unmet-requirement",
				at,
				"a close registration returns void",
			);
		if (
			this.#handles.get(handle.name)!.allocator !== undefined &&
			this.#handles.get(handle.name)!.destroy !== undefined
		)
			throw new FfiFactError(
				"unmet-requirement",
				at,
				"initialized caller storage uses its destructor binding for cleanup",
			);
		const handles = param.value.params.flatMap((value, position) =>
			typeof value === "object" && value.kind === "handle" ? [{ value, position }] : [],
		);
		if (
			handles.length > 1 ||
			handles.some(
				({ value }) =>
					value.pass !== "pointer" ||
					this.#handles.get(value.name)?.family !==
						this.#handles.get(handle.name)?.family,
			)
		)
			throw new FfiFactError(
				"unmet-requirement",
				at,
				"only the closing handle may be a completion pointer argument",
			);
		const keyParam = handles[0]?.position;
		if (
			keyParam !== undefined &&
			factsAt(index).callback?.params?.[String(keyParam + 1)]?.nullable === true
		)
			throw new FfiFactError(
				"unmet-requirement",
				at,
				"the completion's closing handle is nonnullable",
			);
		if (keyParam === undefined && param.value.route.kind === "key")
			throw new FfiFactError(
				"unmet-requirement",
				at,
				"a close completion needs its handle or user data to route it",
			);
		params[entry.param] = {
			...param,
			value: {
				...param.value,
				params: param.value.params.map((value, position) =>
					position === keyParam && typeof value === "object" && value.kind === "handle"
						? { ...value, nullable: false }
						: value,
				),
				lifetime: {
					kind: "completion",
					param: input.param,
					key,
					...(keyParam === undefined ? {} : { handle: keyParam }),
				},
				...(param.value.route.kind === "key"
					? { route: { kind: "key", param: keyParam } }
					: {}),
			},
		};
	}

	/**
	 * Whether a setter's result is the callback it replaced, or that callback's user
	 * data, which only the binding could interpret.
	 */
	#returnsPrevious(declaration: CFunction, callback: number, data: boolean): boolean {
		const result = resolveCType(this.#model, declaration.returns);
		if (result.kind !== "pointer") return false;
		if (data && resolveCType(this.#model, result.to).kind === "void") return true;
		return (
			formatCDeclaration(result) ===
			formatCDeclaration(resolveCType(this.#model, declaration.params[callback]!.type))
		);
	}

	/**
	 * Check that a `free` fact releases a copied result and names a function that
	 * takes the pointer to release.
	 */
	#free(name: string | undefined, value: JsValue, at: string): void {
		if (name === undefined) return;
		if (value.kind !== "string" && value.kind !== "bytes" && value.kind !== "sequence") {
			throw new FfiFactError(
				"inapplicable",
				`${at}.free`,
				"free applies to string, buffer, and array results",
			);
		}
		const declaration = modelIndex(this.#model).functions.get(name);
		const param = declaration?.params[0];
		if (
			declaration === undefined ||
			declaration.params.length !== 1 ||
			param === undefined ||
			resolveCType(this.#model, param.type).kind !== "pointer"
		) {
			throw new FfiFactError(
				"inapplicable",
				`${at}.free`,
				`'${name}' is not a function that takes one pointer`,
			);
		}
	}

	#callable(
		type: CType,
		facts: MaligatorFfiValueFacts,
		context: {
			readonly targetType: string;
			readonly path: string;
			readonly site: string;
			readonly location: CFunction["location"];
			readonly owner?: string;
		},
	): Mapping<Extract<JsResult, { kind: "callable" }>> {
		const at = `${context.path}.callable`;
		const callable = facts.callable!;
		const pointer = resolveCType(this.#model, type);
		const target =
			pointer.kind === "pointer" ? resolveCType(this.#model, pointer.to) : undefined;
		if (target?.kind !== "function")
			throw new FfiFactError("inapplicable", at, "callable requires a function pointer");
		if (Object.keys(facts).some((key) => key !== "callable" && key !== "nullable"))
			throw new FfiFactError(
				"conflict",
				at,
				"callable cannot accompany another value representation",
			);
		if (callable.lifetime === "owner" && context.owner === undefined)
			throw new FfiFactError(
				"inapplicable",
				`${at}.lifetime`,
				"owner lifetime requires a function-table field",
			);
		if (target.variadic)
			return {
				gap: "a callable function pointer needs a fixed signature",
				code: "unsupported",
			};
		const params: Array<MaligatorFfiValueFacts | undefined> = [];
		for (const [key, value] of Object.entries(callable.params ?? {})) {
			const index = Number(key) - 1;
			if (!Number.isInteger(index) || index < 0 || index >= target.params.length)
				throw new FfiFactError(
					"unknown-name",
					`${at}.params.${key}`,
					"the function pointer has no such parameter",
				);
			params[index] = value;
		}
		const name = `mal_callable_${this.#callableCount++}`;
		const signature = this.function(
			{
				name,
				returns: target.returns,
				params: target.params.map((type, index) => ({ name: `arg${index + 1}`, type })),
				variadic: false,
				inline: false,
				attributes: [],
				location: context.location,
			},
			{ params, returns: callable.returns ?? NO_FACTS },
			undefined,
			{
				targetType: context.targetType,
				path: at,
				site: context.site,
				...(callable.lifetime === "owner" ? { owner: context.owner! } : {}),
			},
		);
		if ("gaps" in signature)
			return {
				gap: `callable signature: ${signature.gaps.map((gap) => `${gap.at}: ${gap.reason}`).join("; ")}`,
				code: signature.gaps[0]!.code,
			};
		if (signature.params.some(({ value }) => value.kind === "callback"))
			this.hasCallableCallbacks = true;
		return {
			value: {
				kind: "callable",
				name,
				targetType: context.targetType,
				site: context.site,
				signature,
				nullable: true,
				...(callable.lifetime === "owner" ? { owner: context.owner! } : {}),
			},
		};
	}

	function(
		declaration: CFunction,
		facts: FunctionFacts,
		closes: number | undefined,
		callableContext?: {
			readonly targetType?: string;
			readonly path: string;
			readonly site: string;
			readonly owner?: string;
			readonly fixedArrayParameters?: true;
			readonly boundedGlobal?: GlobalAccessor["bounded"];
			readonly retainedGlobal?: GlobalAccessor["retained"];
		},
	): BoundFunction | UnboundFunction {
		const where = (at: string): string =>
			`${callableContext?.path ?? `functions.${declaration.name}`}.${at}`;
		const gaps: Array<Gap> = [];
		if (declaration.variadic) {
			gaps.push({
				at: "arguments",
				code: "variants",
				reason: "variadic arguments need a fact per call",
			});
		}
		const names = declaration.params.map(
			(param, index) => param.name ?? `arg${index + 1}`,
		);
		const factsAt = (index: number): MaligatorFfiValueFacts =>
			facts.params[index] ?? NO_FACTS;
		const parameterIndex = (reference: string, at: string): number => {
			const index = /^\d+$/.test(reference)
				? Number(reference) - 1
				: declaration.params.findIndex((param) => param.name === reference);
			if (index < 0 || index >= declaration.params.length) {
				throw new FfiFactError(
					"unknown-name",
					where(at),
					`${declaration.name} has no parameter '${reference}'`,
				);
			}
			return index;
		};
		const map = (
			type: CType,
			position: Position,
			valueFacts: MaligatorFfiValueFacts,
			at: string,
		): Mapping => {
			const resolved = resolveCType(this.#model, type);
			if (resolved.kind === "pointer" && callableContext?.retainedGlobal !== undefined)
				return { value: { kind: callableContext.retainedGlobal.format, nullable: true } };
			if (resolved.kind === "array" && callableContext?.boundedGlobal !== undefined)
				return { value: { kind: callableContext.boundedGlobal.format, nullable: false } };
			if (valueFacts.callable !== undefined) {
				if (position !== "return")
					throw new FfiFactError(
						"inapplicable",
						`${where(at)}.callable`,
						"callable applies to returned function pointers",
					);
				const source =
					callableContext?.targetType === undefined
						? declaration.name
						: `((${callableContext.targetType}) nullptr)`;
				const arguments_ = declaration.params.map(({ type }) => {
					const resolved = resolveCType(this.#model, type);
					if (resolved.kind !== "record") return "0";
					const spelling =
						type.kind === "typedef"
							? formatCDeclaration(type)
							: (this.#accesses.get(resolved.name)?.spelling ?? formatCDeclaration(type));
					return `(${spelling}){0}`;
				});
				const targetType = `__typeof__(${source}(${arguments_.join(", ")}))`;
				return this.#callable(type, valueFacts, {
					targetType,
					path: where(at),
					site: `${callableContext?.site ?? declaration.name} result`,
					location: declaration.location,
					...(callableContext?.owner === undefined
						? {}
						: { owner: callableContext.owner }),
				});
			}
			for (const fact of ["string", "bytes", "array"] as const) {
				if (
					valueFacts[fact] !== undefined &&
					resolved.kind !== "pointer" &&
					resolved.kind !== "array"
				) {
					throw new FfiFactError(
						"inapplicable",
						where(at),
						`${fact} applies to pointers, not ${formatCDeclaration(type)}`,
					);
				}
			}
			try {
				return this.value(type, position, valueFacts);
			} catch (error) {
				if (error instanceof FfiFactError) throw error.under(where(at));
				throw error;
			}
		};
		const mapResult = (
			type: CType,
			valueFacts: MaligatorFfiValueFacts,
			at: string,
		): Mapping<JsResult> => resultMapping(map(type, "return", valueFacts, at));
		/** A C array parameter's storage lends its rows; other inputs map as parameters. */
		const mapInput = (
			type: CType,
			storage: boolean,
			valueFacts: MaligatorFfiValueFacts,
			at: string,
		): Mapping<JsInput> =>
			storage
				? lentMapping(map(type, "field", valueFacts, at))
				: inputMapping(map(type, "param", valueFacts, at));

		const counts = new Map<number, Array<number>>();
		declaration.params.forEach((_, index) => {
			const valueFacts = factsAt(index);
			const counted = valueCount(valueFacts);
			if (counted === undefined) return;
			const at = `params.${names[index]}.${counted.kind}.length`;
			const count = parameterIndex(counted.count.length, at);
			const capacity =
				valueFacts.array?.capacity === undefined
					? undefined
					: parameterIndex(
							valueFacts.array.capacity,
							`params.${names[index]}.array.capacity`,
						);
			const countPointer =
				resolveCType(this.#model, declaration.params[count]!.type).kind === "pointer";
			if (valueFacts.out === true && !countPointer && capacity !== count)
				throw new FfiFactError(
					"unmet-requirement",
					where(at),
					"an out value needs a count C writes through a pointer",
				);
			if (count === index) {
				throw new FfiFactError(
					"unmet-requirement",
					where(at),
					"a parameter cannot count itself",
				);
			}
			if (capacity !== count) {
				const sources = counts.get(count) ?? [];
				sources.push(index);
				counts.set(count, sources);
			}
		});
		for (const [count, sources] of counts) {
			if (sources.length < 2) continue;
			if (
				resolveCType(this.#model, declaration.params[count]!.type).kind === "pointer" ||
				sources.some(
					(source) => factsAt(source).out === true || factsAt(source).inout === true,
				)
			)
				throw new FfiFactError(
					"unmet-requirement",
					`${where(`params.${names[count]}`)}`,
					"a shared count needs integer input lengths",
				);
		}
		// The user-data parameters that route callbacks, mapped to their callback argument.
		const callbackData = new Map<number, number>();
		declaration.params.forEach((_, index) => {
			const callback = factsAt(index).callback;
			if (callback?.data === undefined) return;
			const at = `params.${names[index]}.callback.data`;
			const data = parameterIndex(callback.data, at);
			const resolved = resolveCType(this.#model, declaration.params[data]!.type);
			if (
				resolved.kind !== "pointer" ||
				resolveCType(this.#model, resolved.to).kind !== "void" ||
				callbackData.has(data) ||
				counts.has(data)
			) {
				throw new FfiFactError(
					"inapplicable",
					where(at),
					`'${callback.data}' is not a free void * parameter`,
				);
			}
			callbackData.set(data, index);
		});
		// The destructor parameters of kept callbacks, mapped to their callback argument.
		const callbackReleases = new Map<number, number>();
		declaration.params.forEach((_, index) => {
			const release = factsAt(index).callback?.release;
			if (release === undefined) return;
			const at = `params.${names[index]}.callback.release`;
			const position = parameterIndex(release, at);
			const resolved = resolveCType(this.#model, declaration.params[position]!.type);
			const target =
				resolved.kind === "pointer" ? resolveCType(this.#model, resolved.to) : undefined;
			const first = target?.kind === "function" ? target.params[0] : undefined;
			const takes = first === undefined ? undefined : resolveCType(this.#model, first);
			if (
				target?.kind !== "function" ||
				target.variadic ||
				target.params.length !== 1 ||
				takes === undefined ||
				resolveCType(this.#model, target.returns).kind !== "void" ||
				takes.kind !== "pointer" ||
				resolveCType(this.#model, takes.to).kind !== "void" ||
				callbackData.has(position) ||
				callbackReleases.has(position) ||
				counts.has(position) ||
				factsAt(position).callback !== undefined
			) {
				throw new FfiFactError(
					"inapplicable",
					where(at),
					`'${release}' is not a free void (*)(void *) parameter`,
				);
			}
			callbackReleases.set(position, index);
		});
		const resultCounted = valueCount(facts.returns);
		const resultCount =
			resultCounted === undefined
				? undefined
				: parameterIndex(
						resultCounted.count.length,
						`returns.${resultCounted.kind}.length`,
					);

		const params: Array<MappedParameter> = [];
		const args: Array<Argument> = [];
		const outputs: Array<MappedOutput> = [];
		declaration.params.forEach((param, index) => {
			const name = names[index]!;
			const valueFacts = factsAt(index);
			const at = `params.${name}`;
			const gap = (reason: string, code: GapCode): void => {
				gaps.push({ at: `param ${index + 1} (${name})`, code, reason, param: index });
			};
			if (
				valueFacts.borrowed === true &&
				valueFacts.out !== true &&
				valueFacts.inout !== true
			) {
				throw new FfiFactError("inapplicable", where(at), "borrowed applies to results");
			}
			const resolved = resolveCType(this.#model, param.type);
			const routed = callbackData.get(index);
			const released = callbackReleases.get(index);
			if (released !== undefined) {
				args.push({ kind: "callback-release", of: released });
				return;
			}
			if (valueFacts.constant !== undefined || valueFacts.sizeof !== undefined) {
				if (
					Object.keys(valueFacts).length > 1 ||
					routed !== undefined ||
					counts.has(index) ||
					resultCount === index
				) {
					throw new FfiFactError(
						"conflict",
						where(at),
						"a constant parameter takes no other role",
					);
				}
				if (valueFacts.sizeof !== undefined) {
					const record = factRecord(this.#model, valueFacts.sizeof);
					const mapped =
						resolved.kind === "integer" ? this.#integer(resolved.name) : undefined;
					if (record?.complete !== true)
						throw new FfiFactError(
							"unmet-requirement",
							`${where(at)}.sizeof`,
							`'${valueFacts.sizeof}' needs a complete record type`,
						);
					if (
						mapped === undefined ||
						!("value" in mapped) ||
						(mapped.value.kind !== "integer" && mapped.value.kind !== "bigint")
					)
						throw new FfiFactError(
							"inapplicable",
							`${where(at)}.sizeof`,
							"sizeof requires an integer parameter",
						);
					args.push({
						kind: "constant",
						expression: `sizeof(${recordSpelling(this.#model, record)})`,
						sizeLimit: (
							(1n << BigInt(mapped.value.bits - (mapped.value.signed ? 1 : 0))) -
							1n
						).toString(),
					});
				} else args.push({ kind: "constant", expression: valueFacts.constant! });
				return;
			}
			if (routed !== undefined) {
				args.push({ kind: "callback-data", of: routed });
				return;
			}
			if (valueFacts.callback !== undefined) {
				const mapped = this.#callback(
					resolved,
					valueFacts.nullable === true,
					valueFacts.callback,
					where(at),
				);
				if ("gap" in mapped) gap(mapped.gap, mapped.code);
				else {
					params.push({ name, type: param.type, value: mapped.value });
					args.push({ kind: "input", param: params.length - 1 });
				}
				return;
			}
			const counted = counts.get(index);
			if (counted !== undefined || resultCount === index) {
				const pointer = resolved.kind === "pointer";
				const countType = pointer ? resolveCType(this.#model, resolved.to) : resolved;
				if (countType.kind === "integer" && "gap" in this.#integer(countType.name))
					throw new FfiFactError(
						"unmet-requirement",
						where(at),
						"a count needs a supported integer of at most 64 bits",
					);
				const invalidWrittenCount =
					pointer &&
					counted !== undefined &&
					(resultCount === index ||
						counted.some((source) => {
							const sourceFacts = factsAt(source);
							const written = sourceFacts.out === true || sourceFacts.inout === true;
							return (
								sourceFacts.bytes === undefined &&
								!(
									written &&
									(sourceFacts.array !== undefined ||
										typeof sourceFacts.string === "object")
								)
							);
						}));
				const integer =
					countType.kind === "integer" ? this.#integer(countType.name) : undefined;
				if (
					integer === undefined ||
					!("value" in integer) ||
					(integer.value.kind !== "integer" && integer.value.kind !== "bigint") ||
					invalidWrittenCount
				) {
					throw new FfiFactError(
						"inapplicable",
						where(at),
						"a count must be an integer parameter",
					);
				}
				const width = { bits: integer.value.bits, signed: integer.value.signed };
				if (valueFacts.borrowed === true)
					throw new FfiFactError(
						"inapplicable",
						`${where(at)}.borrowed`,
						"requires a handle output",
					);
				if (counted !== undefined && pointer) {
					const written = mapResult(resolved.to, NO_FACTS, at);
					if ("gap" in written) {
						gap(written.gap, written.code);
						return;
					}
					args.push({ kind: "count", of: counted, ...width, output: outputs.length });
					outputs.push({ name, type: resolved.to, value: written.value });
					return;
				}
				if (counted !== undefined) {
					args.push({ kind: "count", of: counted, ...width });
					return;
				}
				if (pointer) {
					args.push({ kind: "result-count" });
					return;
				}
				// An integer input that also sizes the result stays a parameter.
			}
			if (valueFacts.out === true || valueFacts.inout === true) {
				const fact = valueFacts.out === true ? "out" : "inout";
				if (valueFacts.array?.writable === true)
					throw new FfiFactError(
						"conflict",
						`${where(at)}.array.writable`,
						`${fact} arrays already return C's values`,
					);
				if (valueFacts.out === true && valueFacts.inout === true) {
					throw new FfiFactError(
						"conflict",
						where(at),
						"a parameter is out or inout, not both",
					);
				}
				if (resolved.kind !== "pointer") {
					throw new FfiFactError(
						"inapplicable",
						`${where(at)}.${fact}`,
						`${name} is not a pointer`,
					);
				}
				const callerArray =
					valueFacts.array !== undefined &&
					(valueFacts.inout === true || valueFacts.array.capacity !== undefined);
				if (callerArray) {
					if (valueFacts.free !== undefined || valueFacts.nullable === true)
						throw new FfiFactError(
							"conflict",
							`${where(at)}.array`,
							"caller-owned buffers cannot be nullable or declare free",
						);
					if (valueFacts.inout === true && valueFacts.array?.capacity !== undefined)
						throw new FfiFactError(
							"conflict",
							`${where(at)}.array.capacity`,
							"inout buffers use their input length",
						);
					const element = resolveCType(this.#model, resolved.to);
					if (["void", "function", "unsupported", "typedef"].includes(element.kind)) {
						gap("caller-owned array buffers need complete value elements", "unsupported");
						return;
					}
					if (element.kind === "pointer" && valueFacts.borrowed === undefined) {
						gap(
							"caller pointer buffers require an explicit borrowed ownership choice",
							"ownership",
						);
						return;
					}
					const written = mapResult(
						param.type,
						{
							...valueFacts,
							array: { ...valueFacts.array!, capacity: undefined },
							nullable: undefined,
						},
						at,
					);
					if ("gap" in written) {
						gap(written.gap, written.code);
						return;
					}
					if (valueFacts.borrowed === true && !this.#canBorrowResult(written.value))
						throw new FfiFactError(
							"inapplicable",
							`${where(at)}.borrowed`,
							"requires a handle output or flat pointer array",
						);
					const pointers =
						written.value.kind === "sequence" &&
						written.value.of.kind === "handle" &&
						written.value.of.pass === "pointer" &&
						this.#handles.get(written.value.of.name)!.representation === "pointer" &&
						(valueFacts.borrowed === true ||
							(this.#handles.get(written.value.of.name)!.destroy !== undefined &&
								this.#handles.get(written.value.of.name)!.allocator === undefined));
					if (element.kind === "pointer" && !pointers) {
						gap(
							"caller pointer buffers need independent pointer handles with an explicit ownership choice",
							"ownership",
						);
						return;
					}
					if (
						written.value.kind !== "sequence" ||
						(this.#containsHandle(written.value) &&
							!(
								(hasOwnedRecordFields(written.value, this) || pointers) &&
								supportsResultTransaction(written.value, {
									records: this.records,
									handles: this.#handles,
								})
							))
					) {
						gap(
							"resource-bearing caller array outputs need explicit element ownership",
							"ownership",
						);
						return;
					}
					const capacity =
						valueFacts.inout === true
							? "input"
							: parameterIndex(valueFacts.array!.capacity!, `${at}.array.capacity`);
					if (typeof capacity === "number") {
						const type = resolveCType(this.#model, declaration.params[capacity]!.type);
						if (
							capacity === index ||
							type.kind !== "integer" ||
							"gap" in this.#integer(type.name)
						)
							throw new FfiFactError(
								"inapplicable",
								`${where(at)}.array.capacity`,
								"capacity must be an integer input of at most 64 bits",
							);
					}
					const output = outputs.length;
					outputs.push({
						name,
						type: param.type,
						value: { ...written.value, nullable: false },
						count: parameterIndex(valueFacts.array!.length, `${at}.array.length`),
						capacity,
					});
					if (valueFacts.inout !== true) {
						args.push({ kind: "out", output });
						return;
					}
					const read = mapInput(param.type, false, valueFacts, at);
					if ("gap" in read) {
						gap(read.gap, read.code);
						return;
					}
					params.push({ name, type: param.type, value: read.value });
					args.push({ kind: "inout", param: params.length - 1, output });
					return;
				}
				if (
					resolveCType(this.#model, resolved.to).kind === "array" &&
					valueFacts.array !== undefined
				) {
					gap("counted outer array outputs need an explicit capacity", "array");
					return;
				}
				const written = mapResult(
					resolved.to,
					{ ...valueFacts, nullable: undefined },
					at,
				);
				if ("gap" in written) {
					gap(written.gap, written.code);
					return;
				}
				if (valueFacts.borrowed === true && !this.#canBorrowResult(written.value))
					throw new FfiFactError(
						"inapplicable",
						`${where(at)}.borrowed`,
						"requires a handle output or flat pointer array",
					);

				if (
					written.value.kind === "array" &&
					this.#containsHandle(written.value) &&
					!(
						hasOwnedRecordFields(written.value, this) &&
						supportsResultTransaction(written.value, {
							records: this.records,
							handles: this.#handles,
						})
					)
				) {
					gap(
						"resource-bearing array outputs need explicit element ownership",
						"ownership",
					);
					return;
				}
				if (
					valueFacts.inout === true &&
					written.value.kind === "handle" &&
					written.value.pass === "copy"
				) {
					gap(
						`${written.value.name}: copied-handle inout would duplicate ownership; pass the handle pointer directly for in-place updates`,
						"unsupported",
					);
					return;
				}
				this.#free(valueFacts.free, written.value, where(at));
				const output = outputs.length;
				const countedOutput = valueCount(valueFacts);
				outputs.push({
					name,
					type: resolved.to,
					value: written.value,
					...(countedOutput === undefined
						? {}
						: {
								count: parameterIndex(
									countedOutput.count.length,
									`${at}.${countedOutput.kind}.length`,
								),
							}),
				});
				if (valueFacts.inout !== true) {
					args.push({ kind: "out", output });
					return;
				}
				const read = mapInput(
					resolved.to,
					resolveCType(this.#model, resolved.to).kind === "array",
					valueFacts.string === undefined
						? {
								nullable: valueFacts.nullable,
								...(valueFacts.shape === undefined ? {} : { shape: valueFacts.shape }),
							}
						: {
								string: valueFacts.string,
								nullable: valueFacts.nullable,
							},
					at,
				);
				if ("gap" in read) {
					gap(read.gap, read.code);
					return;
				}
				params.push({ name, type: resolved.to, value: read.value });
				args.push({ kind: "inout", param: params.length - 1, output });
				return;
			}
			if (valueFacts.free !== undefined) {
				throw new FfiFactError(
					"inapplicable",
					`${where(at)}.free`,
					"free applies to results and out parameters",
				);
			}
			const mapped = mapInput(
				param.type,
				callableContext?.fixedArrayParameters === true && resolved.kind === "array",
				valueFacts,
				at,
			);
			if ("gap" in mapped) {
				gap(mapped.gap, mapped.code);
				return;
			}
			if (
				valueFacts.nullable === true &&
				!("nullable" in mapped.value && mapped.value.nullable)
			) {
				throw new FfiFactError(
					"inapplicable",
					where(at),
					"nullable applies to string, handle, buffer, and array pointers",
				);
			}
			const writable = valueFacts.array?.writable === true;
			const view = this.#numericView(param.type, mapped.value, writable);
			if (writable && view === undefined)
				throw new FfiFactError(
					"inapplicable",
					`${where(at)}.array.writable`,
					"writable views need a non-const arithmetic pointer",
				);
			params.push({
				name,
				type: param.type,
				value: mapped.value,
				...(view === undefined ? {} : { view }),
				...(writable ? { writable: true as const } : {}),
			});
			args.push({ kind: "input", param: params.length - 1 });
		});

		for (const output of outputs) {
			if (typeof output.capacity === "number" && args[output.capacity]?.kind !== "input")
				throw new FfiFactError(
					"unmet-requirement",
					`${where(`params.${output.name}.array.capacity`)}`,
					"capacity must remain an integer input",
				);
		}

		const replaced =
			gaps.length === 0
				? this.#replaced(declaration, factsAt, args, params, where)
				: undefined;
		if (gaps.length === 0)
			this.#closingCallback(declaration, factsAt, args, params, where);
		// Owners root kept registrations, so they follow the lifetimes resolved above.
		if (gaps.length === 0)
			declaration.params.forEach((parameter, index) => {
				const owner = factsAt(index).callback?.owner;
				if (owner === undefined) return;
				const at = `params.${parameter.name ?? String(index + 1)}.callback.owner`;
				const selected = args[parameterIndex(owner, at)];
				const entry = args[index];
				const root = selected?.kind === "input" ? params[selected.param] : undefined;
				if (
					entry?.kind !== "input" ||
					selected?.kind !== "input" ||
					root?.value.kind !== "handle" ||
					root.value.pass === "copy"
				)
					throw new FfiFactError(
						"unmet-requirement",
						where(at),
						"an input handle with stable C storage",
					);
				const callback = params[entry.param]!;
				const value = callback.value;
				if (
					value.kind !== "callback" ||
					(value.lifetime.kind !== "released" && value.lifetime.kind !== "replaced")
				)
					throw new FfiFactError(
						"inapplicable",
						where(at),
						"owner applies to callbacks kept with release or replaced",
					);
				params[entry.param] = {
					...callback,
					value: { ...value, lifetime: { ...value.lifetime, owner: selected.param } },
				};
			});
		if (facts.returns.constant !== undefined) {
			throw new FfiFactError(
				"inapplicable",
				where("returns.constant"),
				"constant applies to parameters",
			);
		}
		if (facts.returns.sizeof !== undefined)
			throw new FfiFactError(
				"inapplicable",
				where("returns.sizeof"),
				"sizeof applies to parameters",
			);
		const returns: Mapping<JsResult> =
			replaced !== undefined &&
			Object.keys(facts.returns).length === 0 &&
			this.#returnsPrevious(
				declaration,
				replaced,
				factsAt(replaced).callback?.data !== undefined,
			)
				? { value: { kind: "undefined" } }
				: mapResult(declaration.returns, facts.returns, "returns");
		if ("value" in returns) {
			if (facts.returns.borrowed === true && !this.#canBorrowResult(returns.value)) {
				throw new FfiFactError(
					"inapplicable",
					where("returns.borrowed"),
					"requires a handle or flat pointer array",
				);
			}
			const counted =
				returns.value.kind === "bytes" ||
				returns.value.kind === "sequence" ||
				(returns.value.kind === "string" && returns.value.counted === true);
			if (
				callableContext?.boundedGlobal === undefined &&
				callableContext?.retainedGlobal === undefined &&
				counted !== (resultCount !== undefined)
			) {
				throw new FfiFactError(
					"unmet-requirement",
					where("returns"),
					"a buffer or array result needs its length",
				);
			}
			this.#free(facts.returns.free, returns.value, where("returns"));
			if (
				outputs.some((output) => output.name === "result") &&
				returns.value.kind !== "undefined"
			) {
				throw new FfiFactError(
					"conflict",
					where("params.result"),
					"an output named 'result' hides the result",
				);
			}
		} else gaps.push({ at: "return", code: returns.code, reason: returns.gap });
		if ("value" in returns) {
			const results = [returns.value, ...outputs.map((output) => output.value)];
			if (
				results.some(
					(value) =>
						hasOwnedRecordFields(value, this) ||
						hasResultHandles(value, { records: this.records, handles: this.#handles }),
				) &&
				!results.every((value) =>
					supportsResultTransaction(value, {
						records: this.records,
						handles: this.#handles,
					}),
				)
			)
				gaps.push({
					at: "return",
					code: "unsupported",
					reason: "pointer results require a complete result transaction",
				});
		}
		let initializes: BoundFunction["initializes"];
		if (facts.initializes !== undefined) {
			const at = "initializes";
			const index = parameterIndex(facts.initializes.param, `${at}.param`);
			const input = args[index];
			const value = input?.kind === "input" ? params[input.param]!.value : undefined;
			const pointer = resolveCType(this.#model, declaration.params[index]!.type);
			const target =
				pointer.kind === "pointer" ? resolveCType(this.#model, pointer.to) : undefined;
			const handle = value?.kind === "handle" ? this.#handles.get(value.name) : undefined;
			if (
				input?.kind !== "input" ||
				value?.kind !== "handle" ||
				value.pass !== "pointer" ||
				value.nullable ||
				pointer.kind !== "pointer" ||
				(target !== undefined && "const" in target && target.const === true) ||
				handle?.allocator === undefined ||
				handle.destroy === undefined ||
				!handle.collect ||
				handle.destroy.success !== undefined ||
				closes !== undefined
			)
				throw new FfiFactError(
					"unmet-requirement",
					where(at),
					"requires a mutable nonnullable caller-storage input with an unconditional collecting destructor",
				);
			if (
				facts.initializes.success !== undefined &&
				!["integer", "enum", "bool"].includes(
					resolveCType(this.#model, declaration.returns).kind,
				)
			)
				throw new FfiFactError(
					"inapplicable",
					`${where(at)}.success`,
					"requires an integer or boolean return",
				);
			initializes = {
				param: input.param,
				...(facts.initializes.success === undefined
					? {}
					: { success: facts.initializes.success }),
			};
		}
		if ("gap" in returns || gaps.length > 0) {
			return { name: declaration.name, declaration, gaps };
		}
		if (
			closes !== undefined &&
			(args[0]?.kind !== "input" ||
				args[0].param !== closes ||
				params[closes]?.value.kind !== "handle")
		)
			throw new FfiFactError(
				"unmet-requirement",
				where("params"),
				"a destroy function must keep its handle as an input",
			);
		return {
			name: declaration.name,
			declaration,
			...(facts.callsJavaScript === undefined
				? {}
				: { callsJavaScript: facts.callsJavaScript }),
			params,
			arguments: args,
			returns: returns.value,
			...(resultCount === undefined ? {} : { resultCount }),
			outputs,
			...(closes === undefined ? {} : { closes }),
			...(initializes === undefined ? {} : { initializes }),
		};
	}
}

function constantValue(value: bigint, mapping: JsValue): bigint | number {
	return mapping.kind === "bigint" ? value : Number(value);
}

/**
 * Bind one variant of a variadic function as a declaration whose variadic arguments
 * have the variant's types, exported under the variant's name. Calls still go to the
 * variadic function, so the C compiler applies the default argument promotions.
 */
function planVariant(
	model: CModel,
	planner: Planner,
	declaration: CFunction,
	stated: FunctionFacts | undefined,
	name: string,
	variant: MaligatorFfiVariant,
): BoundFunction | UnboundFunction {
	const at = `functions.${declaration.name}.variants.${name}`;
	if (!declaration.variadic) {
		throw new FfiFactError("inapplicable", at, `${declaration.name} is not variadic`);
	}
	const fixed = declaration.params.length;
	const params = [
		...declaration.params,
		...variant.args.map((spelling, index) => {
			const type = parseCType(spelling);
			if (
				type.kind === "unsupported" ||
				resolveCType(model, type).kind === "unsupported"
			) {
				throw new FfiFactError(
					"unknown-name",
					`${at}.args[${index}]`,
					`'${spelling}' is not a C type`,
				);
			}
			return { name: `arg${fixed + index + 1}`, type };
		}),
	];
	const paramFacts: Array<MaligatorFfiValueFacts | undefined> = params.map(
		(_, index) => stated?.params[index],
	);
	for (const [key, valueFacts] of Object.entries(variant.params ?? {})) {
		const index = /^\d+$/.test(key)
			? Number(key) - 1
			: params.findIndex((param) => param.name === key);
		if (index < fixed || index >= params.length) {
			throw new FfiFactError(
				"unknown-name",
				`${at}.params.${key}`,
				`${name} has no such variadic argument`,
			);
		}
		paramFacts[index] = valueFacts;
	}
	const result = planner.function(
		{ ...declaration, params, variadic: false },
		{
			params: paramFacts,
			returns: stated?.returns ?? NO_FACTS,
			...(stated?.callsJavaScript === undefined
				? {}
				: { callsJavaScript: stated.callsJavaScript }),
		},
		undefined,
	);
	return { ...result, name };
}

/**
 * Map a library's declarations through its contract facts. A rejected fact throws an
 * `FfiFactError`. With `diagnostics`, a function whose facts the planner rejects is
 * left out and its error collected instead, so one run reports every rejected function
 * and the plan stays incomplete; type facts still throw.
 */
export function planBindings(
	model: CModel,
	facts: LibraryFacts = EMPTY_FACTS,
	diagnostics?: Array<FfiFactError>,
): BindingPlan {
	const handleMap = handleTypes(model, facts);
	const factMap = functionFacts(model, facts);
	const closers = new Map<string, number>();
	for (const handle of handleMap.values()) {
		if (handle.destroy !== undefined) closers.set(handle.destroy.name, 0);
	}
	const planner = new Planner(model, handleMap, facts);
	const functions: Array<BoundFunction> = [];
	const dispatchers: Array<BoundDispatcher> = [];
	const unbound: Array<UnboundFunction> = [];
	const declared = new Set(model.functions.map((declaration) => declaration.name));
	const planDeclaration = (declaration: CFunction): void => {
		const variants = Object.entries(facts.functions[declaration.name]?.variants ?? {});
		if (
			facts.functions[declaration.name]?.dispatch !== undefined &&
			variants.length === 0
		)
			throw new FfiFactError(
				"unmet-requirement",
				`functions.${declaration.name}.dispatch`,
				"provide typed variants",
			);
		if (variants.length > 0) {
			const dispatch = facts.functions[declaration.name]?.dispatch;
			if (dispatch !== undefined) {
				if (declared.has(dispatch) && dispatch !== declaration.name)
					throw new FfiFactError(
						"conflict",
						`functions.${declaration.name}.dispatch`,
						`'${dispatch}' is already a function`,
					);
				declared.add(dispatch);
			}
			const cases: Array<BoundFunction> = [];
			const gaps: Array<Gap> = [];
			// A variadic function binds only through its variants.
			for (const [name, variant] of variants) {
				if (declared.has(name)) {
					throw new FfiFactError(
						"conflict",
						`functions.${declaration.name}.variants.${name}`,
						`'${name}' is already a function`,
					);
				}
				declared.add(name);
				const result = planVariant(
					model,
					planner,
					declaration,
					factMap.get(declaration.name),
					name,
					variant,
				);
				if ("gaps" in result) {
					unbound.push(result);
					gaps.push(
						...result.gaps.map((gap) => ({
							at: name,
							code: gap.code,
							reason: `${gap.at}: ${gap.reason}`,
						})),
					);
				} else {
					functions.push(result);
					cases.push(result);
				}
			}
			if (dispatch !== undefined) {
				if (gaps.length > 0)
					unbound.push({
						name: dispatch,
						dispatchOf: declaration.name,
						declaration,
						gaps,
					});
				else dispatchers.push({ name: dispatch, declaration, cases });
			}
			return;
		}
		const result = planner.function(
			declaration,
			factMap.get(declaration.name) ?? { params: [], returns: NO_FACTS },
			closers.get(declaration.name),
		);
		const asyncName = facts.functions[declaration.name]?.async;
		if (asyncName !== undefined) {
			const at = `functions.${declaration.name}.async`;
			if (declared.has(asyncName)) {
				throw new FfiFactError("conflict", at, `'${asyncName}' is already a function`);
			}
			if ("params" in result && result.params.some((param) => param.writable === true))
				throw new FfiFactError(
					"conflict",
					at,
					"writable array views lend storage only to synchronous calls",
				);
			declared.add(asyncName);
		}
		if ("gaps" in result) unbound.push(result);
		else
			functions.push(asyncName === undefined ? result : { ...result, async: asyncName });
	};
	for (const declaration of model.functions) {
		if (diagnostics === undefined) {
			planDeclaration(declaration);
			continue;
		}
		try {
			planDeclaration(declaration);
		} catch (error) {
			if (!(error instanceof FfiFactError)) throw error;
			diagnostics.push(error);
		}
	}
	const handles = new Map<string, HandleType>();
	const fieldFacts = new Map<string, Readonly<Record<string, MaligatorFfiFieldFacts>>>();
	for (const [name, type] of Object.entries(facts.types)) {
		const record = type.handle === undefined ? undefined : factRecord(model, name);
		if (record !== undefined && type.fields !== undefined)
			fieldFacts.set(record.name, type.fields);
	}
	for (const [name, handle] of handleMap) {
		const record = model.records.get(name);
		const fields = fieldFacts.get(name) ?? {};
		const managedFields =
			record === undefined ? [] : planner.managedFields(record, fields);
		handles.set(name, {
			...handle,
			fields:
				record !== undefined
					? planner.handleFields(
							record,
							managedFields,
							handle,
							fields,
							handle.representation === "struct" || handle.allocator !== undefined,
						)
					: [],
			managedFields,
		});
	}
	const families = new Map<string, Array<HandleType>>();
	for (const handle of handles.values()) {
		const family = families.get(handle.family) ?? [];
		family.push(handle);
		families.set(handle.family, family);
	}
	for (const family of families.values()) {
		const viewNames = new Set(
			family.flatMap((handle) =>
				handle.fields
					.filter(
						(field) => field.value.kind === "callable" || field.value.kind === "handle",
					)
					.map((field) => field.name),
			),
		);
		const owners = new Map<string, string>();
		for (const handle of family)
			for (const field of [...handle.fields, ...handle.managedFields]) {
				if (!viewNames.has(field.name)) continue;
				const previous = owners.get(field.name);
				if (previous !== undefined)
					throw new FfiFactError(
						"conflict",
						`types.${handle.name}.fields.${field.name}`,
						`view field conflicts with ${previous}`,
					);
				owners.set(field.name, `${handle.name}.${field.name}`);
			}
	}
	const lifetimeRoots = new Set(
		[...handles.values()]
			.filter(
				(handle) =>
					handle.destroy !== undefined &&
					(handle.allocator === undefined ||
						(handle.collect && handle.destroy.success === undefined)),
			)
			.map((handle) => handle.family),
	);
	const lifetimeQueue = [...lifetimeRoots];
	for (let index = 0; index < lifetimeQueue.length; index++)
		for (const handle of families.get(lifetimeQueue[index]!)!)
			for (const field of handle.fields) {
				if (field.value.kind !== "handle" || field.value.ownership.kind !== "owner")
					continue;
				const family = handles.get(field.value.name)!.family;
				if (lifetimeRoots.has(family)) continue;
				lifetimeRoots.add(family);
				lifetimeQueue.push(family);
			}
	for (const handle of handles.values())
		if (!lifetimeRoots.has(handle.family))
			for (const field of handle.fields)
				if (field.value.kind === "handle" && field.value.ownership.kind === "owner")
					throw new FfiFactError(
						"unmet-requirement",
						`types.${handle.name}.fields.${field.name}.handle`,
						"owner lifetime requires a destructor-backed owning root",
					);

	const constants: Array<MappedConstant> = [];
	const skippedConstants: Array<SkippedConstant> = [];
	const seen = new Set<string>();
	// An unnamed enum is also registered under its typedef name; visit that entry
	// first so its constants carry the name C code uses.
	const isIdentifier = (name: string): boolean => /^[A-Za-z_]\w*$/.test(name);
	const enums = [...model.enums.values()].sort(
		(left, right) => Number(isIdentifier(right.name)) - Number(isIdentifier(left.name)),
	);
	for (const declaration of enums) {
		if (!declaration.library) continue;
		const type: CType = declaration.named
			? { kind: "enum", name: declaration.name }
			: isIdentifier(declaration.name)
				? { kind: "typedef", name: declaration.name }
				: declaration.underlying;
		const underlying = resolveCType(model, declaration.underlying);
		const mapped = resultMapping(planner.value(underlying, "constant"));
		for (const constant of declaration.constants) {
			if (seen.has(constant.name)) continue;
			seen.add(constant.name);
			if ("gap" in mapped) {
				skippedConstants.push({ name: constant.name, reason: mapped.gap });
				continue;
			}
			constants.push({
				name: constant.name,
				source: "enum",
				type,
				value: mapped.value,
				known: constantValue(constant.value, mapped.value),
				...(constant.doc === undefined ? {} : { doc: constant.doc }),
			});
		}
	}
	for (const macro of model.macros) {
		if (!macro.library) continue;
		if (seen.has(macro.name)) continue;
		seen.add(macro.name);
		if (macro.contextual === true) {
			skippedConstants.push({
				name: macro.name,
				reason: "depends on the macro expansion context",
			});
			continue;
		}
		const resolved = resolveCType(model, macro.type);
		const isString =
			resolved.kind === "array" &&
			resolveCType(model, resolved.of).kind === "integer" &&
			typeof macro.value === "string";
		const mapped: Mapping<JsResult> = isString
			? { value: { kind: "string", nullable: false } }
			: resultMapping(planner.value(macro.type, "constant"));
		if ("gap" in mapped) {
			skippedConstants.push({ name: macro.name, reason: mapped.gap });
			continue;
		}
		if (hasOwnedRecordFields(mapped.value, planner)) {
			skippedConstants.push({
				name: macro.name,
				reason: "a constant cannot transfer independently owned record fields",
			});
			continue;
		}
		const known =
			mapped.value.kind === "native"
				? undefined
				: typeof macro.value === "bigint"
					? constantValue(macro.value, mapped.value)
					: macro.value;
		constants.push({
			name: macro.name,
			source: "macro",
			type: macro.type,
			value: mapped.value,
			...(known === undefined ? {} : { known }),
			...(macro.doc === undefined ? {} : { doc: macro.doc }),
		});
	}
	for (const macro of model.untypedMacros) {
		if (!macro.library || macro.parameters !== undefined) continue;
		if (seen.has(macro.name)) continue;
		skippedConstants.push({ name: macro.name, reason: "not a constant expression" });
	}
	constants.sort((left, right) =>
		left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
	);
	for (const dispatch of dispatchers)
		if (constants.some((constant) => constant.name === dispatch.name))
			throw new FfiFactError(
				"conflict",
				`functions.${dispatch.declaration.name}.dispatch`,
				`'${dispatch.name}' is already a constant`,
			);
	const occupied = new Set([
		...declared,
		...planner.natives.keys(),
		...constants.map(({ name }) => name),
		...[...handles.values()].flatMap((handle) =>
			handle.allocator === undefined ? [] : [handle.allocator],
		),
	]);
	const retainedCounts = new Set<string>();
	for (const [name, entry] of Object.entries(facts.globals ?? {})) {
		const global = model.globals.find((global) => global.name === name);
		const at = `globals.${name}`;
		if (global === undefined)
			throw new FfiFactError(
				"unknown-name",
				at,
				`the headers declare no global '${name}'`,
			);
		if (global.linkage !== "external")
			throw new FfiFactError(
				"unmet-requirement",
				at,
				"access requires an externally linked C object",
			);
		if (entry.get === undefined && entry.set === undefined)
			throw new FfiFactError(
				"unmet-requirement",
				at,
				"provide a getter or setter export",
			);
		const { bytes, lifetime, ...value } = entry.value ?? {};
		const resolved = resolveCType(model, global.type);
		const format =
			bytes === true ? "bytes" : value.string === true ? "string" : undefined;
		let bounded: GlobalAccessor["bounded"];
		let retained: GlobalAccessor["retained"];
		if (lifetime === "replacement") {
			if (resolved.kind !== "pointer" || resolved.const === true || global.threadLocal)
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.value.lifetime`,
					"replacement requires an assignable non-TLS pointer",
				);
			const element = resolveCType(model, resolved.to);
			const text = value.string === true;
			if (
				!(element.kind === "integer" && model.target.sizes[element.name] === 1) &&
				!(element.kind === "void" && !text)
			)
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.value`,
					"retained pointers require byte storage",
				);
			retained = { format: text ? "string" : "bytes" };
			if (!text) {
				if (bytes === undefined || bytes === true)
					throw new FfiFactError(
						"unmet-requirement",
						`${at}.value.bytes`,
						"retained bytes need a global count",
					);
				const count = model.globals.find((candidate) => candidate.name === bytes.length);
				const type = count === undefined ? undefined : resolveCType(model, count.type);
				const size = type?.kind === "integer" ? model.target.sizes[type.name] : undefined;
				if (
					count === undefined ||
					count.linkage !== "external" ||
					count.threadLocal ||
					type?.kind !== "integer" ||
					type.const === true ||
					size === undefined ||
					size > 8
				)
					throw new FfiFactError(
						"unmet-requirement",
						`${at}.value.bytes.length`,
						"requires a writable external non-TLS integer up to 64 bits",
					);
				if (
					retainedCounts.has(count.name) ||
					facts.globals?.[count.name]?.set !== undefined
				)
					throw new FfiFactError(
						"unmet-requirement",
						`${at}.value.bytes.length`,
						"the count belongs exclusively to one retained pointer",
					);
				retainedCounts.add(count.name);
				retained = {
					...retained,
					count: {
						declaration: count,
						bits: size * 8,
						signed:
							type.name === "char"
								? model.target.charSigned
								: !type.name.startsWith("unsigned"),
					},
				};
			}
		} else if (typeof bytes === "object")
			throw new FfiFactError(
				"unmet-requirement",
				`${at}.value.bytes`,
				"pointer bytes require a replacement lifetime",
			);
		else if (resolved.kind === "array" && format !== undefined) {
			const element = resolveCType(model, resolved.of);
			if (element.kind !== "integer" || model.target.sizes[element.name] !== 1)
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.value`,
					"bounded text and bytes require a one-dimensional byte array",
				);
			if (
				value.borrowed !== undefined ||
				value.callable !== undefined ||
				value.shape !== undefined
			)
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.value`,
					"a bounded array uses only its string or bytes representation",
				);
			bounded = { format };
		} else if (bytes === true)
			throw new FfiFactError(
				"unmet-requirement",
				`${at}.value.bytes`,
				"bytes require a fixed byte array",
			);
		if (
			resolved.kind === "array" &&
			bounded === undefined &&
			Object.keys(value).length > 0
		)
			throw new FfiFactError(
				"unmet-requirement",
				`${at}.value`,
				"fixed arrays use their declared element mapping",
			);
		for (const access of ["get", "set"] as const) {
			const exported = entry[access];
			if (exported === undefined) continue;
			if (occupied.has(exported))
				throw new FfiFactError(
					"conflict",
					`${at}.${access}`,
					`'${exported}' is already an export`,
				);
			occupied.add(exported);
			if (
				access === "set" &&
				retained === undefined &&
				!globalAssignable(model, global.type, handles)
			)
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.set`,
					"a setter requires an assignable value without retained pointers",
				);
			const storageType = globalStorageType(model, global.type, planner.natives);
			if (resolved.kind === "array" && !globalAssignable(model, storageType, handles))
				throw new FfiFactError(
					"unmet-requirement",
					at,
					"an array accessor requires positive signed 32-bit bounds and resource-free values",
				);
			const declaration: CFunction = {
				name: `mal_ffi_global_${access}_${name}`,
				returns: access === "get" ? storageType : { kind: "void" },
				params: access === "get" ? [] : [{ name: "value", type: storageType }],
				variadic: false,
				inline: true,
				attributes: [],
				location: global.location,
				...(global.doc === undefined ? {} : { doc: global.doc }),
			};
			const result = planner.function(
				declaration,
				{
					params: access === "get" ? [] : [NO_FACTS],
					returns: access === "get" && bounded === undefined ? value : NO_FACTS,
				},
				undefined,
				{
					path: access === "get" ? at : `${at}.set`,
					site: exported,
					...(resolved.kind === "array" ? { fixedArrayParameters: true as const } : {}),
					...(bounded === undefined ? {} : { boundedGlobal: bounded }),
					...(retained === undefined ? {} : { retainedGlobal: retained }),
				},
			);
			if (
				!("gaps" in result) &&
				access === "get" &&
				hasOwnedRecordFields(result.returns, planner)
			)
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.value`,
					"a global getter cannot transfer independently owned record fields",
				);
			if (
				!("gaps" in result) &&
				access === "get" &&
				result.returns.kind === "handle" &&
				value.borrowed !== true
			)
				throw new FfiFactError(
					"unmet-requirement",
					`${at}.value`,
					"a global handle requires borrowed: true",
				);
			const binding = {
				...result,
				name: exported,
				global: {
					declaration: global,
					access,
					...(bounded === undefined ? {} : { bounded }),
					...(retained === undefined ? {} : { retained }),
				},
			};
			if ("gaps" in binding) unbound.push(binding);
			else functions.push(binding);
		}
	}
	functions.forEach((binding, index) => {
		if (
			binding.global?.access === "get" &&
			retainedCounts.has(binding.global.declaration.name)
		)
			functions[index] = {
				...binding,
				global: { ...binding.global, synchronizedCount: true },
			};
	});
	for (const native of planner.natives.values()) {
		if (
			declared.has(native.name) ||
			constants.some((entry) => entry.name === native.name) ||
			planner.records.has(native.name) ||
			handles.has(native.name)
		)
			throw new FfiFactError(
				"conflict",
				`types.${native.name}.representation`,
				`'${native.name}' is already an export`,
			);
	}
	for (const handle of handles.values()) {
		if (
			handle.allocator !== undefined &&
			(declared.has(handle.allocator) ||
				constants.some((entry) => entry.name === handle.allocator))
		)
			throw new FfiFactError(
				"conflict",
				`types.${handle.allocator}.handle.storage`,
				`'${handle.allocator}' is already an export`,
			);
	}
	return {
		functions,
		dispatchers,
		hasCallbacks:
			planner.hasCallableCallbacks ||
			functions.some((binding) =>
				binding.params.some(({ value }) => value.kind === "callback"),
			),
		unbound,
		records: planner.records,
		unions: planner.unions,
		tagged: planner.tagged,
		natives: planner.natives,
		handles,
		constants,
		skippedConstants,
	};
}

function globalStorageType(
	model: CModel,
	type: CType,
	natives: ReadonlyMap<string, NativeType>,
): CType {
	const resolved = resolveCType(model, type);
	if (resolved.kind === "array")
		return { ...resolved, of: globalStorageType(model, resolved.of, natives) };
	if (nativeAlias(model, natives, type) !== undefined)
		return "const" in type && type.const === true ? { ...type, const: undefined } : type;
	return "const" in resolved && resolved.const === true
		? { ...resolved, const: undefined }
		: type;
}

function globalAssignable(
	model: CModel,
	type: CType,
	handles: ReadonlyMap<string, Omit<HandleType, "fields" | "managedFields">>,
	seen = new Set<string>(),
): boolean {
	const resolved = resolveCType(model, type);
	if ("const" in resolved && resolved.const === true) return false;
	switch (resolved.kind) {
		case "bool":
		case "integer":
		case "float":
		case "complex":
		case "vector":
		case "bitint":
		case "enum":
			return true;
		case "array":
			return (
				resolved.length !== undefined &&
				resolved.length > 0 &&
				resolved.length <= 0x7fffffff &&
				globalAssignable(model, resolved.of, handles, seen)
			);
		case "record": {
			if (seen.has(resolved.name) || handles.has(resolved.name)) return false;
			const record = model.records.get(resolved.name);
			if (record?.complete !== true) return false;
			const nested = new Set([...seen, resolved.name]);
			return record.fields.every((field) =>
				globalAssignable(model, field.type, handles, nested),
			);
		}
		default:
			return false;
	}
}
