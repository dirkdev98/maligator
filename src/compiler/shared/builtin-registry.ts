import { builtinInvocationSummary } from "./builtin-semantics.ts";
import type { EffectKind } from "./compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL,
	COMPILER_VALUE_KIND_REGISTERED_SYMBOL,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "./compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "./compiler-value-kinds.ts";
import { NO_EFFECT_SUMMARY } from "./effect-summary.ts";
import type { EffectSummary } from "./effect-summary.ts";
import { literalPrimordialBindings } from "./primordial-catalog-data.ts";

export { builtinInvocationSummary } from "./builtin-semantics.ts";
export {
	primordialNode,
	resolvePrimordialProperty,
	provePrimordialAccess,
} from "./primordial-catalog.ts";

export type LiteralPrototypeKey = string | typeof Symbol.iterator;
export type LiteralReceiverKind =
	| "object"
	| "array"
	| "string"
	| "number"
	| "boolean"
	| "bigint";

export interface LiteralPrototypeMethod {
	readonly receiver: LiteralReceiverKind;
	readonly key: LiteralPrototypeKey;
	readonly prototype: string;
	readonly id: string;
	readonly semantics: ReturnType<typeof builtinInvocationSummary>;
}

let literalMethods:
	| {
			readonly methods: ReadonlyArray<LiteralPrototypeMethod>;
			readonly indices: ReadonlyMap<
				LiteralReceiverKind,
				Map<LiteralPrototypeKey, number>
			>;
	  }
	| undefined;

/** Built on first use: summarising every literal method's semantics is startup work. */
function literalMethodTable(): NonNullable<typeof literalMethods> {
	if (literalMethods !== undefined) return literalMethods;
	const methods = literalPrimordialBindings.map(
		([receiver, key, prototype, id, owner]): LiteralPrototypeMethod => ({
			receiver: receiver as LiteralReceiverKind,
			key: key === null ? Symbol.iterator : key,
			prototype,
			id,
			semantics: builtinInvocationSummary(owner, key ?? "Symbol.iterator"),
		}),
	);
	const indices = new Map<LiteralReceiverKind, Map<LiteralPrototypeKey, number>>();
	for (let index = 0; index < methods.length; index++) {
		const method = methods[index]!;
		let receiverIndices = indices.get(method.receiver);
		if (receiverIndices === undefined) {
			receiverIndices = new Map();
			indices.set(method.receiver, receiverIndices);
		}
		receiverIndices.set(method.key, index);
	}
	return (literalMethods = { methods, indices });
}

export function literalPrototypeMethods(): ReadonlyArray<LiteralPrototypeMethod> {
	return literalMethodTable().methods;
}

export function literalPrototypeMethodIndex(
	receiver: LiteralReceiverKind,
	key: LiteralPrototypeKey,
): number | undefined {
	const { indices } = literalMethodTable();
	return indices.get(receiver)?.get(key) ?? indices.get("object")?.get(key);
}

export type BuiltinFeature =
	| "always"
	| "eval"
	| "realms"
	| "regexp"
	| "temporal"
	| "intl";

export interface PrimordialGlobalBinding {
	readonly name: string;
	readonly intrinsic: string;
	readonly feature: BuiltinFeature;
}

export interface BuiltinOperationDescriptor {
	readonly id: string;
	readonly owner: string;
	readonly key: string;
	readonly receiver:
		| "none"
		| "any"
		| "array"
		| "typed-array"
		| "boolean"
		| "number"
		| "string"
		| "regexp"
		| "map"
		| "set"
		| "weak-map"
		| "weak-set";
	readonly arity: { readonly minimum: number; readonly maximum?: number };
	readonly evaluationOrder: "receiver-then-arguments" | "arguments-left-to-right";
	readonly coercionOrder: ReadonlyArray<string>;
	readonly effects: ReadonlyArray<EffectKind>;
	readonly result: string;
	readonly realm: "semantic-identity" | "realm-object-identity";
	readonly lowerings: ReadonlyArray<string>;
	/** Exact argument count currently accepted by the unboxed numeric lowering. */
	readonly nativeNumberArity?: number;
	readonly guardedCallees?: ReadonlyArray<string>;
	readonly callback?: {
		readonly kind?: "reduction";
		readonly argumentIndex: number;
		readonly argumentKinds: ReadonlyArray<"any" | "number" | "object">;
		readonly residualEffects?: EffectSummary;
	};
}

export type ExactBuiltinReceiverProof =
	| "fresh-array"
	| "fresh-map"
	| "fresh-set"
	| "fresh-weak-map"
	| "fresh-weak-set"
	| "intrinsic-object"
	| "primitive-boolean"
	| "primitive-number"
	| "primitive-string";

export interface ExactBuiltinCallDescriptor {
	readonly receiverProof: ExactBuiltinReceiverProof;
	/** Extra arguments are still evaluated in IR, then omitted from the builtin ABI. */
	readonly forwardedArgumentLimit?: number;
	/** Stable C enum member emitted into the shared generated registry include. */
	readonly cOperation: string;
}

/**
 * Canonical admission and wire order for calls whose property/callback seam can
 * disappear in a locked world. New operations register their receiver proof and
 * backend identity here; IR, VM serialization, and generated C enum order derive
 * from this one declaration.
 */
export const exactBuiltinCallDescriptors = {
	"String.prototype.split": {
		receiverProof: "primitive-string",
		forwardedArgumentLimit: 2,
		cOperation: "MAL_DIRECT_BUILTIN_STRING_SPLIT",
	},
	"Array.prototype.push": {
		receiverProof: "fresh-array",
		cOperation: "MAL_DIRECT_BUILTIN_ARRAY_PUSH",
	},
	"Array.prototype.pop": {
		receiverProof: "fresh-array",
		forwardedArgumentLimit: 0,
		cOperation: "MAL_DIRECT_BUILTIN_ARRAY_POP",
	},
	"Object.hasOwn": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 2,
		cOperation: "MAL_DIRECT_BUILTIN_OBJECT_HAS_OWN",
	},
	"Object.is": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 2,
		cOperation: "MAL_DIRECT_BUILTIN_OBJECT_IS",
	},
	"String.prototype.charCodeAt": {
		receiverProof: "primitive-string",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_STRING_CHAR_CODE_AT",
	},
	"Map.prototype.get": {
		receiverProof: "fresh-map",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_MAP_GET",
	},
	"Map.prototype.set": {
		receiverProof: "fresh-map",
		forwardedArgumentLimit: 2,
		cOperation: "MAL_DIRECT_BUILTIN_MAP_SET",
	},
	"Map.prototype.has": {
		receiverProof: "fresh-map",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_MAP_HAS",
	},
	"Map.prototype.delete": {
		receiverProof: "fresh-map",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_MAP_DELETE",
	},
	"Set.prototype.add": {
		receiverProof: "fresh-set",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_SET_ADD",
	},
	"Set.prototype.has": {
		receiverProof: "fresh-set",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_SET_HAS",
	},
	"Set.prototype.delete": {
		receiverProof: "fresh-set",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_SET_DELETE",
	},
	"WeakMap.prototype.get": {
		receiverProof: "fresh-weak-map",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_WEAK_MAP_GET",
	},
	"WeakMap.prototype.set": {
		receiverProof: "fresh-weak-map",
		forwardedArgumentLimit: 2,
		cOperation: "MAL_DIRECT_BUILTIN_WEAK_MAP_SET",
	},
	"WeakMap.prototype.has": {
		receiverProof: "fresh-weak-map",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_WEAK_MAP_HAS",
	},
	"WeakMap.prototype.delete": {
		receiverProof: "fresh-weak-map",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_WEAK_MAP_DELETE",
	},
	"WeakSet.prototype.has": {
		receiverProof: "fresh-weak-set",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_WEAK_SET_HAS",
	},
	"WeakSet.prototype.add": {
		receiverProof: "fresh-weak-set",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_WEAK_SET_ADD",
	},
	"WeakSet.prototype.delete": {
		receiverProof: "fresh-weak-set",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_WEAK_SET_DELETE",
	},
	"Object.keys": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_OBJECT_KEYS",
	},
	"Object.values": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_OBJECT_VALUES",
	},
	"Number.isNaN": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_NUMBER_IS_NAN",
	},
	"Number.isFinite": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_NUMBER_IS_FINITE",
	},
	"Number.isInteger": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_NUMBER_IS_INTEGER",
	},
	"Number.isSafeInteger": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_NUMBER_IS_SAFE_INTEGER",
	},
	"Number.prototype.valueOf": {
		receiverProof: "primitive-number",
		forwardedArgumentLimit: 0,
		cOperation: "MAL_DIRECT_BUILTIN_NUMBER_VALUE_OF",
	},
	"Boolean.prototype.valueOf": {
		receiverProof: "primitive-boolean",
		forwardedArgumentLimit: 0,
		cOperation: "MAL_DIRECT_BUILTIN_BOOLEAN_VALUE_OF",
	},
	"Date.now": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 0,
		cOperation: "MAL_DIRECT_BUILTIN_DATE_NOW",
	},
	"Date.parse": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_DATE_PARSE",
	},
	"Date.UTC": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 7,
		cOperation: "MAL_DIRECT_BUILTIN_DATE_UTC",
	},
	"ArrayBuffer.isView": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_ARRAY_BUFFER_IS_VIEW",
	},
	"JSON.isRawJSON": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_JSON_IS_RAW_JSON",
	},
} as const satisfies Record<string, ExactBuiltinCallDescriptor>;

export type DirectBuiltinOperationId = keyof typeof exactBuiltinCallDescriptors;

export const directBuiltinOperationIds = Object.keys(
	exactBuiltinCallDescriptors,
) as Array<DirectBuiltinOperationId>;

export function exactBuiltinCallDescriptor(
	id: string,
): (ExactBuiltinCallDescriptor & { readonly id: DirectBuiltinOperationId }) | undefined {
	if (!Object.hasOwn(exactBuiltinCallDescriptors, id)) return undefined;
	const operation = id as DirectBuiltinOperationId;
	return { id: operation, ...exactBuiltinCallDescriptors[operation] };
}

/**
 * The Phase 1 object policy deliberately covers every object-valued intrinsic
 * initialized by a Realm. Host objects are installed later and remain mutable.
 */
export const primordialObjectPolicy = {
	kind: "all-initialized-intrinsics" as const,
	excludedIntrinsics: [
		"MAL_INTRINSIC_GLOBAL_THIS",
		"MAL_INTRINSIC_CONSOLE",
		"MAL_INTRINSIC_REGEXP_LEGACY_STATE",
	] as const,
};

export const primordialGlobalBindings: ReadonlyArray<PrimordialGlobalBinding> = [
	["globalThis", "MAL_INTRINSIC_GLOBAL_THIS", "always"],
	["Object", "MAL_INTRINSIC_OBJECT_CONSTRUCTOR", "always"],
	["Function", "MAL_INTRINSIC_FUNCTION_CONSTRUCTOR", "always"],
	["Array", "MAL_INTRINSIC_ARRAY_CONSTRUCTOR", "always"],
	["Error", "MAL_INTRINSIC_ERROR_CONSTRUCTOR", "always"],
	["TypeError", "MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR", "always"],
	["RangeError", "MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR", "always"],
	["ReferenceError", "MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR", "always"],
	["SyntaxError", "MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR", "always"],
	["URIError", "MAL_INTRINSIC_URI_ERROR_CONSTRUCTOR", "always"],
	["EvalError", "MAL_INTRINSIC_EVAL_ERROR_CONSTRUCTOR", "always"],
	["AggregateError", "MAL_INTRINSIC_AGGREGATE_ERROR_CONSTRUCTOR", "always"],
	["SuppressedError", "MAL_INTRINSIC_SUPPRESSED_ERROR_CONSTRUCTOR", "always"],
	["DisposableStack", "MAL_INTRINSIC_DISPOSABLE_STACK_CONSTRUCTOR", "always"],
	["AsyncDisposableStack", "MAL_INTRINSIC_ASYNC_DISPOSABLE_STACK_CONSTRUCTOR", "always"],
	["String", "MAL_INTRINSIC_STRING_CONSTRUCTOR", "always"],
	["Number", "MAL_INTRINSIC_NUMBER_CONSTRUCTOR", "always"],
	["Boolean", "MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR", "always"],
	["Symbol", "MAL_INTRINSIC_SYMBOL_CONSTRUCTOR", "always"],
	["BigInt", "MAL_INTRINSIC_BIGINT_CONSTRUCTOR", "always"],
	["Map", "MAL_INTRINSIC_MAP_CONSTRUCTOR", "always"],
	["Set", "MAL_INTRINSIC_SET_CONSTRUCTOR", "always"],
	["WeakMap", "MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR", "always"],
	["WeakSet", "MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR", "always"],
	["WeakRef", "MAL_INTRINSIC_WEAK_REF_CONSTRUCTOR", "always"],
	["FinalizationRegistry", "MAL_INTRINSIC_FINALIZATION_REGISTRY_CONSTRUCTOR", "always"],
	["ArrayBuffer", "MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR", "always"],
	["SharedArrayBuffer", "MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR", "always"],
	["Int8Array", "MAL_INTRINSIC_TYPED_ARRAY_INT8_CONSTRUCTOR", "always"],
	["Uint8Array", "MAL_INTRINSIC_TYPED_ARRAY_UINT8_CONSTRUCTOR", "always"],
	["Uint8ClampedArray", "MAL_INTRINSIC_TYPED_ARRAY_UINT8_CLAMPED_CONSTRUCTOR", "always"],
	["Int16Array", "MAL_INTRINSIC_TYPED_ARRAY_INT16_CONSTRUCTOR", "always"],
	["Uint16Array", "MAL_INTRINSIC_TYPED_ARRAY_UINT16_CONSTRUCTOR", "always"],
	["Int32Array", "MAL_INTRINSIC_TYPED_ARRAY_INT32_CONSTRUCTOR", "always"],
	["Uint32Array", "MAL_INTRINSIC_TYPED_ARRAY_UINT32_CONSTRUCTOR", "always"],
	["Float32Array", "MAL_INTRINSIC_TYPED_ARRAY_FLOAT32_CONSTRUCTOR", "always"],
	["Float64Array", "MAL_INTRINSIC_TYPED_ARRAY_FLOAT64_CONSTRUCTOR", "always"],
	["BigInt64Array", "MAL_INTRINSIC_TYPED_ARRAY_BIGINT64_CONSTRUCTOR", "always"],
	["BigUint64Array", "MAL_INTRINSIC_TYPED_ARRAY_BIGUINT64_CONSTRUCTOR", "always"],
	["DataView", "MAL_INTRINSIC_DATA_VIEW_CONSTRUCTOR", "always"],
	["parseInt", "MAL_INTRINSIC_PARSE_INT", "always"],
	["parseFloat", "MAL_INTRINSIC_PARSE_FLOAT", "always"],
	["isNaN", "MAL_INTRINSIC_IS_NAN", "always"],
	["isFinite", "MAL_INTRINSIC_IS_FINITE", "always"],
	["Math", "MAL_INTRINSIC_MATH", "always"],
	["JSON", "MAL_INTRINSIC_JSON", "always"],
	["Atomics", "MAL_INTRINSIC_ATOMICS", "always"],
	["Reflect", "MAL_INTRINSIC_REFLECT", "always"],
	["Proxy", "MAL_INTRINSIC_PROXY_CONSTRUCTOR", "always"],
	["Promise", "MAL_INTRINSIC_PROMISE_CONSTRUCTOR", "always"],
	["Date", "MAL_INTRINSIC_DATE_CONSTRUCTOR", "always"],
	["Iterator", "MAL_INTRINSIC_ITERATOR_CONSTRUCTOR", "always"],
	["AsyncIterator", "MAL_INTRINSIC_ASYNC_ITERATOR_CONSTRUCTOR", "always"],
	["decodeURI", "MAL_INTRINSIC_DECODE_URI", "always"],
	["decodeURIComponent", "MAL_INTRINSIC_DECODE_URI_COMPONENT", "always"],
	["encodeURI", "MAL_INTRINSIC_ENCODE_URI", "always"],
	["encodeURIComponent", "MAL_INTRINSIC_ENCODE_URI_COMPONENT", "always"],
	["escape", "MAL_INTRINSIC_COUNT", "always"],
	["unescape", "MAL_INTRINSIC_COUNT", "always"],
	["NaN", "MAL_INTRINSIC_NAN_VALUE", "always"],
	["Infinity", "MAL_INTRINSIC_INFINITY_VALUE", "always"],
	["undefined", "MAL_INTRINSIC_COUNT", "always"],
	["eval", "MAL_INTRINSIC_EVAL", "eval"],
	["RegExp", "MAL_INTRINSIC_REGEXP_CONSTRUCTOR", "regexp"],
	["Temporal", "MAL_INTRINSIC_TEMPORAL", "temporal"],
	["Intl", "MAL_INTRINSIC_INTL", "intl"],
	["ShadowRealm", "MAL_INTRINSIC_SHADOW_REALM_CONSTRUCTOR", "realms"],
].map(([name, intrinsic, feature]) => ({
	name,
	intrinsic,
	feature,
})) as ReadonlyArray<PrimordialGlobalBinding>;

/** Canonical unary numeric Math surface shared by direct calls and region plans. */
export const mathUnaryOperationKeys = [
	["Math.abs", "abs"],
	["Math.floor", "floor"],
	["Math.ceil", "ceil"],
	["Math.round", "round"],
	["Math.trunc", "trunc"],
	["Math.sqrt", "sqrt"],
	["Math.cbrt", "cbrt"],
	["Math.sign", "sign"],
	["Math.log", "log"],
	["Math.log2", "log2"],
	["Math.log10", "log10"],
	["Math.exp", "exp"],
	["Math.sin", "sin"],
	["Math.cos", "cos"],
	["Math.tan", "tan"],
	["Math.asin", "asin"],
	["Math.acos", "acos"],
	["Math.atan", "atan"],
	["Math.sinh", "sinh"],
	["Math.cosh", "cosh"],
	["Math.tanh", "tanh"],
	["Math.asinh", "asinh"],
	["Math.acosh", "acosh"],
	["Math.atanh", "atanh"],
	["Math.log1p", "log1p"],
	["Math.expm1", "expm1"],
	["Math.fround", "fround"],
] as const;

export type MathUnaryOperationKey = (typeof mathUnaryOperationKeys)[number][1];

const mathOperations: ReadonlyArray<BuiltinOperationDescriptor> =
	mathUnaryOperationKeys.map(([id, key]) => ({
		id,
		owner: "Math",
		key,
		receiver: "none",
		arity: { minimum: 1, maximum: 1 },
		evaluationOrder: "arguments-left-to-right",
		coercionOrder: ["argument-number"],
		effects: ["coerce", "throw"],
		result: "number",
		realm: "semantic-identity",
		lowerings: ["generic", "native-number"],
		nativeNumberArity: 1,
	}));

const mathBinaryOperationKeys = [
	["Math.min", "min"],
	["Math.max", "max"],
] as const;

const mathBinaryOperations: ReadonlyArray<BuiltinOperationDescriptor> =
	mathBinaryOperationKeys.map(([id, key]): BuiltinOperationDescriptor => ({
		id,
		owner: "Math",
		key,
		receiver: "none",
		arity: { minimum: 0 },
		evaluationOrder: "arguments-left-to-right",
		coercionOrder: ["arguments-number-left-to-right"],
		effects: ["coerce", "throw"],
		result: "number",
		realm: "semantic-identity",
		lowerings: ["generic", "native-number"],
		nativeNumberArity: 2,
	}));

const arrayIterationOperations: ReadonlyArray<BuiltinOperationDescriptor> = (
	[
		["forEach", "undefined", false],
		["some", "boolean", false],
		["every", "boolean", false],
		["find", "any", false],
		["findIndex", "number", false],
		["map", "array", true],
		["filter", "array", true],
		["reduce", "any", false],
		["reduceRight", "any", false],
		["findLast", "any", false],
		["findLastIndex", "number", false],
		["flatMap", "array", true],
	] as const
).map(([key, result, allocates]): BuiltinOperationDescriptor => ({
	id: `Array.prototype.${key}`,
	owner: "Array.prototype",
	key,
	receiver: "array",
	arity: { minimum: 1 },
	evaluationOrder: "receiver-then-arguments",
	coercionOrder: ["receiver-object", "receiver-length"],
	effects: [
		"coerce",
		"property-access",
		"call-user-code",
		...(allocates ? (["allocate"] as const) : []),
		"throw",
		"safepoint",
	],
	result,
	realm: "semantic-identity",
	lowerings: ["generic", "inlined-callback-loop"],
	callback: {
		...(key === "reduce" || key === "reduceRight" ? { kind: "reduction" as const } : {}),
		argumentIndex: 0,
		argumentKinds:
			key === "reduce" || key === "reduceRight"
				? ["any", "any", "number", "object"]
				: ["any", "number", "object"],
	},
}));

const typedArrayIterationOperations: ReadonlyArray<BuiltinOperationDescriptor> =
	arrayIterationOperations
		.filter(({ key }) => key !== "flatMap")
		.map((array) => ({
			...array,
			id: `TypedArray.prototype.${array.key}`,
			owner: "TypedArray.prototype",
			receiver: "typed-array",
			coercionOrder: [],
			effects: ["property-access", "call-user-code", "allocate", "throw", "safepoint"],
			result: array.result === "array" ? "object" : array.result,
			lowerings: ["generic"],
		}));

const iterationInvocationFamilies: ReadonlyArray<BuiltinOperationDescriptor> =
	typedArrayIterationOperations.map((typed): BuiltinOperationDescriptor => ({
		...typed,
		id:
			typed.key === "forEach"
				? "Collection.prototype.forEach"
				: `ArrayOrTypedArray.prototype.${typed.key}`,
		owner:
			typed.key === "forEach" ? "Collection.prototype" : "ArrayOrTypedArray.prototype",
		receiver: "any",
		coercionOrder: ["receiver-object", "receiver-length"],
		effects: ["coerce", ...typed.effects],
		guardedCallees: [
			`Array.prototype.${typed.key}`,
			typed.id,
			...(typed.key === "forEach"
				? ["Map.prototype.forEach", "Set.prototype.forEach"]
				: []),
		],
		...(typed.key === "forEach"
			? { callback: { argumentIndex: 0, argumentKinds: ["any", "any", "object"] } }
			: {}),
	}));

/** DataView element types whose accessors compiled code performs inline; BigInt and Float16 stay generic. */
export const DATA_VIEW_ACCESSOR_TYPES = [
	"Int8",
	"Uint8",
	"Int16",
	"Uint16",
	"Int32",
	"Uint32",
	"Float32",
	"Float64",
] as const;

const collectionIterationEffects: EffectSummary = Object.freeze({
	...NO_EFFECT_SUMMARY,
	reads: Object.freeze(["object-property"] as const),
	mayThrow: true,
	mayGc: true,
});

export const builtinOperations: ReadonlyArray<BuiltinOperationDescriptor> = [
	{
		id: "Array.isArray",
		owner: "Array",
		key: "isArray",
		receiver: "none",
		arity: { minimum: 0, maximum: 1 },
		evaluationOrder: "arguments-left-to-right",
		coercionOrder: [],
		effects: ["property-access", "throw", "safepoint"],
		result: "boolean",
		realm: "realm-object-identity",
		lowerings: ["generic"],
	},
	...(
		[
			["ArrayBuffer", "isView"],
			["JSON", "isRawJSON"],
		] as const
	).map(([owner, key]): BuiltinOperationDescriptor => ({
		id: `${owner}.${key}`,
		owner,
		key,
		receiver: "none",
		arity: { minimum: 0, maximum: 1 },
		evaluationOrder: "arguments-left-to-right",
		coercionOrder: [],
		effects: [],
		result: "boolean",
		realm: "semantic-identity",
		lowerings: ["generic", "exact-builtin-call"],
	})),
	{
		id: "Object.is",
		owner: "Object",
		key: "is",
		receiver: "none",
		arity: { minimum: 0, maximum: 2 },
		evaluationOrder: "arguments-left-to-right",
		coercionOrder: [],
		effects: [],
		result: "boolean",
		realm: "semantic-identity",
		lowerings: ["generic", "exact-builtin-call", "guarded-same-value"],
	},
	{
		id: "Object.hasOwn",
		owner: "Object",
		key: "hasOwn",
		receiver: "none",
		arity: { minimum: 0 },
		evaluationOrder: "arguments-left-to-right",
		coercionOrder: ["argument-object", "property-key"],
		effects: ["coerce", "property-access", "call-user-code", "throw", "safepoint"],
		result: "boolean",
		realm: "semantic-identity",
		lowerings: ["generic", "exact-builtin-call"],
	},
	{
		id: "Object.keys",
		owner: "Object",
		key: "keys",
		receiver: "none",
		arity: { minimum: 0, maximum: 1 },
		evaluationOrder: "arguments-left-to-right",
		coercionOrder: ["argument-object", "own-property-keys"],
		effects: ["property-access", "call-user-code", "allocate", "throw", "safepoint"],
		result: "array-of-strings",
		realm: "realm-object-identity",
		lowerings: ["generic", "exact-builtin-call"],
	},
	{
		id: "Object.values",
		owner: "Object",
		key: "values",
		receiver: "none",
		arity: { minimum: 0, maximum: 1 },
		evaluationOrder: "arguments-left-to-right",
		coercionOrder: ["argument-object", "own-property-keys", "property-values"],
		effects: ["property-access", "call-user-code", "allocate", "throw", "safepoint"],
		result: "array-of-values",
		realm: "realm-object-identity",
		lowerings: ["generic", "exact-builtin-call"],
	},
	...(["isNaN", "isFinite", "isInteger", "isSafeInteger"] as const).map(
		(key): BuiltinOperationDescriptor => ({
			id: `Number.${key}`,
			owner: "Number",
			key,
			receiver: "none",
			arity: { minimum: 0, maximum: 1 },
			evaluationOrder: "arguments-left-to-right",
			coercionOrder: [],
			effects: [],
			result: "boolean",
			realm: "semantic-identity",
			lowerings: ["generic", "exact-builtin-call", "guarded-number-predicate"],
		}),
	),
	...(["toFixed", "toExponential", "toPrecision"] as const).map(
		(key): BuiltinOperationDescriptor => ({
			id: `Number.prototype.${key}`,
			owner: "Number.prototype",
			key,
			receiver: "number",
			arity: { minimum: 0, maximum: 1 },
			evaluationOrder: "receiver-then-arguments",
			coercionOrder: ["receiver-number-brand", "option-number"],
			effects: ["coerce", "call-user-code", "allocate", "throw", "safepoint"],
			result: "string",
			realm: "realm-object-identity",
			lowerings: ["generic", "guarded-number-format"],
		}),
	),
	{
		id: "Number.prototype.valueOf",
		owner: "Number.prototype",
		key: "valueOf",
		receiver: "number",
		arity: { minimum: 0, maximum: 0 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: [],
		effects: [],
		result: "number",
		realm: "semantic-identity",
		lowerings: ["generic", "exact-builtin-call"],
	},
	{
		id: "Boolean.prototype.valueOf",
		owner: "Boolean.prototype",
		key: "valueOf",
		receiver: "boolean",
		arity: { minimum: 0, maximum: 0 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: [],
		effects: [],
		result: "boolean",
		realm: "semantic-identity",
		lowerings: ["generic", "exact-builtin-call", "guarded-boolean"],
	},
	{
		id: "Boolean.prototype.toString",
		owner: "Boolean.prototype",
		key: "toString",
		receiver: "boolean",
		arity: { minimum: 0, maximum: 0 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: ["receiver-boolean-brand"],
		effects: ["allocate", "throw", "safepoint"],
		result: "string",
		realm: "semantic-identity",
		lowerings: ["generic", "guarded-boolean"],
	},
	{
		id: "Boolean",
		owner: "globalThis",
		key: "Boolean",
		receiver: "none",
		arity: { minimum: 0, maximum: 1 },
		evaluationOrder: "arguments-left-to-right",
		coercionOrder: [],
		effects: [],
		result: "boolean",
		realm: "semantic-identity",
		lowerings: ["generic", "guarded-boolean"],
	},
	{
		id: "Date.now",
		owner: "Date",
		key: "now",
		receiver: "none",
		arity: { minimum: 0, maximum: 0 },
		evaluationOrder: "arguments-left-to-right",
		coercionOrder: [],
		// The clock is host state: each invocation is an observable read even when
		// its numeric result is unused or happens to equal an adjacent read.
		effects: ["read-host"],
		result: "number",
		realm: "semantic-identity",
		lowerings: ["generic", "exact-builtin-call"],
	},
	{
		id: "Date.parse",
		owner: "Date",
		key: "parse",
		receiver: "none",
		arity: { minimum: 0, maximum: 1 },
		evaluationOrder: "arguments-left-to-right",
		coercionOrder: ["argument-string"],
		effects: ["coerce", "call-user-code", "allocate", "throw", "safepoint"],
		result: "number",
		realm: "semantic-identity",
		lowerings: ["generic", "exact-builtin-call"],
	},
	{
		id: "Date.UTC",
		owner: "Date",
		key: "UTC",
		receiver: "none",
		arity: { minimum: 0, maximum: 7 },
		evaluationOrder: "arguments-left-to-right",
		coercionOrder: [
			"year-number",
			"month-number",
			"date-number",
			"hours-number",
			"minutes-number",
			"seconds-number",
			"milliseconds-number",
		],
		effects: ["coerce", "call-user-code", "throw", "safepoint"],
		result: "number",
		realm: "semantic-identity",
		lowerings: ["generic", "exact-builtin-call"],
	},
	{
		id: "Array.prototype.push",
		owner: "Array.prototype",
		key: "push",
		receiver: "any",
		arity: { minimum: 0 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: ["receiver-length", "arguments-left-to-right"],
		effects: [
			"property-access",
			"call-user-code",
			"write-prototype",
			"throw",
			"safepoint",
		],
		result: "array-length",
		realm: "semantic-identity",
		lowerings: ["generic", "guarded-dense-append", "exact-builtin-call"],
	},
	{
		id: "Array.prototype.at",
		owner: "Array.prototype",
		key: "at",
		receiver: "any",
		arity: { minimum: 0 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: ["receiver-length", "index-integer"],
		effects: ["coerce", "property-access", "call-user-code", "throw", "safepoint"],
		result: "array-element-or-undefined",
		realm: "semantic-identity",
		lowerings: ["generic", "guarded-array-at"],
	},
	{
		id: "Array.prototype.pop",
		owner: "Array.prototype",
		key: "pop",
		receiver: "any",
		arity: { minimum: 0 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: ["receiver-length"],
		effects: [
			"property-access",
			"call-user-code",
			"write-prototype",
			"throw",
			"safepoint",
		],
		result: "array-element-or-undefined",
		realm: "semantic-identity",
		lowerings: ["generic", "exact-builtin-call"],
	},
	{
		id: "Array.prototype.shift",
		owner: "Array.prototype",
		key: "shift",
		receiver: "any",
		arity: { minimum: 0 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: ["receiver-length"],
		effects: [
			"property-access",
			"call-user-code",
			"write-prototype",
			"throw",
			"safepoint",
		],
		result: "array-element-or-undefined",
		realm: "semantic-identity",
		lowerings: ["generic", "exact-builtin-call"],
	},
	{
		id: "Array.prototype.unshift",
		owner: "Array.prototype",
		key: "unshift",
		receiver: "any",
		arity: { minimum: 0 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: ["receiver-length", "arguments-left-to-right"],
		effects: [
			"property-access",
			"call-user-code",
			"write-prototype",
			"throw",
			"safepoint",
		],
		result: "array-length",
		realm: "semantic-identity",
		lowerings: ["generic", "exact-builtin-call"],
	},
	{
		id: "String.prototype.charCodeAt",
		owner: "String.prototype",
		key: "charCodeAt",
		receiver: "string",
		arity: { minimum: 0, maximum: 1 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: ["receiver-string", "position-integer"],
		effects: ["coerce", "throw"],
		result: "number",
		realm: "semantic-identity",
		lowerings: ["generic", "guarded-primitive-string", "exact-builtin-call"],
	},
	...(["get", "set", "has", "delete"] as const).map(
		(key): BuiltinOperationDescriptor => ({
			id: `Map.prototype.${key}`,
			owner: "Map.prototype",
			key,
			receiver: "map",
			arity: {
				minimum: key === "set" ? 2 : 1,
				maximum: key === "set" ? 2 : 1,
			},
			evaluationOrder: "receiver-then-arguments",
			coercionOrder: [],
			effects: ["throw", "safepoint"],
			result: key === "get" ? "any" : key === "set" ? "receiver" : "boolean",
			realm: "semantic-identity",
			lowerings: ["generic", "guarded-native-collection", "exact-builtin-call"],
		}),
	),
	...(["Map", "Set"] as const).map((collection): BuiltinOperationDescriptor => ({
		id: `${collection}.prototype.forEach`,
		owner: `${collection}.prototype`,
		key: "forEach",
		receiver: collection === "Map" ? "map" : "set",
		arity: { minimum: 1 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: [],
		effects: ["call-user-code", "throw", "safepoint"],
		result: "undefined",
		realm: "semantic-identity",
		lowerings: ["generic"],
		callback: {
			argumentIndex: 0,
			argumentKinds: ["any", "any", "object"],
			residualEffects: collectionIterationEffects,
		},
	})),
	...(["add", "has", "delete"] as const).map((key): BuiltinOperationDescriptor => ({
		id: `Set.prototype.${key}`,
		owner: "Set.prototype",
		key,
		receiver: "set",
		arity: { minimum: 1, maximum: 1 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: [],
		effects: ["throw", "safepoint"],
		result: key === "add" ? "receiver" : "boolean",
		realm: "semantic-identity",
		lowerings: ["generic", "guarded-native-collection", "exact-builtin-call"],
	})),
	...(["WeakMap", "WeakSet"] as const).flatMap((collection) =>
		(collection === "WeakMap"
			? ["get", "set", "has", "delete"]
			: ["add", "has", "delete"]
		).map((key): BuiltinOperationDescriptor => ({
			id: `${collection}.prototype.${key}`,
			owner: `${collection}.prototype`,
			key,
			receiver: collection === "WeakMap" ? "weak-map" : "weak-set",
			arity: { minimum: key === "set" ? 2 : 1, maximum: key === "set" ? 2 : 1 },
			evaluationOrder: "receiver-then-arguments",
			coercionOrder: [],
			effects: ["throw", "safepoint"],
			result:
				key === "get" ? "any" : key === "set" || key === "add" ? "receiver" : "boolean",
			realm: "semantic-identity",
			lowerings: ["generic", "guarded-native-collection", "exact-builtin-call"],
		})),
	),
	...DATA_VIEW_ACCESSOR_TYPES.flatMap((type): Array<BuiltinOperationDescriptor> => [
		{
			id: `DataView.prototype.get${type}`,
			owner: "DataView.prototype",
			key: `get${type}`,
			receiver: "any",
			arity: { minimum: 1 },
			evaluationOrder: "receiver-then-arguments",
			coercionOrder: ["byte-offset-index", "little-endian-boolean"],
			effects: ["coerce", "call-user-code", "throw", "safepoint"],
			result: "number",
			realm: "semantic-identity",
			lowerings: ["generic", "guarded-data-view-access"],
		},
		{
			id: `DataView.prototype.set${type}`,
			owner: "DataView.prototype",
			key: `set${type}`,
			receiver: "any",
			arity: { minimum: 2 },
			evaluationOrder: "receiver-then-arguments",
			coercionOrder: ["byte-offset-index", "value-number", "little-endian-boolean"],
			effects: ["coerce", "call-user-code", "throw", "safepoint"],
			result: "undefined",
			realm: "semantic-identity",
			lowerings: ["generic", "guarded-data-view-access"],
		},
	]),
	...(["slice", "substring", "substr"] as const).map(
		(key): BuiltinOperationDescriptor => ({
			id: `String.prototype.${key}`,
			owner: "String.prototype",
			key,
			receiver: "string",
			arity: { minimum: 0, maximum: 2 },
			evaluationOrder: "receiver-then-arguments",
			coercionOrder: [
				"receiver-string",
				"start-integer",
				key === "substr" ? "length-integer" : "end-integer",
			],
			effects: ["coerce", "allocate", "throw", "safepoint"],
			result: "string",
			realm: "semantic-identity",
			lowerings: ["generic", "span-projection"],
		}),
	),
	...(["toString", "valueOf"] as const).map((key): BuiltinOperationDescriptor => ({
		id: `String.prototype.${key}`,
		owner: "String.prototype",
		key,
		receiver: "string",
		arity: { minimum: 0 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: [],
		effects: ["throw", "safepoint"],
		result: "string",
		realm: "semantic-identity",
		lowerings: ["generic", "span-projection"],
	})),
	...(["trim", "trimStart", "trimEnd", "trimLeft", "trimRight"] as const).map(
		(key): BuiltinOperationDescriptor => ({
			id: `String.prototype.${key}`,
			owner: "String.prototype",
			key,
			receiver: "string",
			arity: { minimum: 0 },
			evaluationOrder: "receiver-then-arguments",
			coercionOrder: ["receiver-string"],
			effects: ["coerce", "allocate", "throw", "safepoint"],
			result: "string",
			realm: "semantic-identity",
			lowerings:
				key === "trim"
					? ["generic", "span-projection", "split-cursor-span"]
					: ["generic", "span-projection"],
		}),
	),
	{
		id: "String.prototype.split",
		owner: "String.prototype",
		key: "split",
		receiver: "string",
		arity: { minimum: 0, maximum: 2 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: [
			"separator-symbol-split",
			"receiver-string",
			"separator-string",
			"limit-uint32",
		],
		effects: [
			"coerce",
			"property-access",
			"call-user-code",
			"allocate",
			"throw",
			"safepoint",
		],
		result: "array-of-strings",
		realm: "semantic-identity",
		lowerings: [
			"generic",
			"closed-string-split",
			"projected-string-split",
			"exact-builtin-call",
		],
	},
	{
		id: "RegExp.prototype.exec",
		owner: "RegExp.prototype",
		key: "exec",
		receiver: "regexp",
		arity: { minimum: 1, maximum: 1 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: ["argument-string"],
		effects: ["coerce", "property-access", "allocate", "throw", "safepoint"],
		result: "regexp-match-or-null",
		realm: "semantic-identity",
		lowerings: ["generic", "capture-projection"],
	},
	...arrayIterationOperations,
	...typedArrayIterationOperations,
	...iterationInvocationFamilies,
	...mathOperations,
	...mathBinaryOperations,
];

const normalResultKindMasks = {
	number: COMPILER_VALUE_KIND_NUMBER,
	string: COMPILER_VALUE_KIND_STRING,
	boolean: COMPILER_VALUE_KIND_BOOLEAN,
	bigint: COMPILER_VALUE_KIND_BIGINT,
	symbol: COMPILER_VALUE_KIND_SYMBOL,
	"unregistered-symbol": COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL,
	"registered-symbol": COMPILER_VALUE_KIND_REGISTERED_SYMBOL,
	undefined: COMPILER_VALUE_KIND_UNDEFINED,
	object: COMPILER_VALUE_KIND_OBJECT,
	"boolean-or-undefined": COMPILER_VALUE_KIND_BOOLEAN | COMPILER_VALUE_KIND_UNDEFINED,
	"number-or-bigint": COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_BIGINT,
	"number-or-undefined": COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED,
	"string-or-undefined": COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_UNDEFINED,
	"object-or-null": COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_NULL,
	"object-or-undefined": COMPILER_VALUE_KIND_OBJECT | COMPILER_VALUE_KIND_UNDEFINED,
	"weak-value-or-undefined":
		COMPILER_VALUE_KIND_OBJECT |
		COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL |
		COMPILER_VALUE_KIND_UNDEFINED,
};

const normalResultKinds = new Map<string, CompilerValueKindMask>();
const normalResultCallabilities = new Map<string, boolean>();
for (const [owner, result, methods, callability] of [
	["", "number", ["Number", "parseInt", "parseFloat"]],
	["", "boolean", ["Boolean", "isNaN", "isFinite"]],
	[
		"",
		"string",
		[
			"String",
			"Date",
			"encodeURI",
			"encodeURIComponent",
			"decodeURI",
			"decodeURIComponent",
			"escape",
			"unescape",
		],
	],
	["", "bigint", ["BigInt"]],
	["", "unregistered-symbol", ["Symbol"]],
	["Number", "number", ["parseInt", "parseFloat"]],
	["Number", "boolean", ["isNaN", "isFinite", "isInteger", "isSafeInteger"]],
	["Number.prototype", "number", ["valueOf"]],
	[
		"Number.prototype",
		"string",
		["toString", "toFixed", "toExponential", "toPrecision", "toLocaleString"],
	],
	["Boolean.prototype", "boolean", ["valueOf"]],
	["Boolean.prototype", "string", ["toString"]],
	["BigInt", "bigint", ["asIntN", "asUintN"]],
	["BigInt.prototype", "bigint", ["valueOf"]],
	["BigInt.prototype", "string", ["toString", "toLocaleString"]],
	["Symbol", "registered-symbol", ["for"]],
	["Symbol", "string-or-undefined", ["keyFor"]],
	["Symbol.prototype", "symbol", ["valueOf"]],
	["Symbol.prototype", "string", ["toString"]],
	["Symbol.prototype", "string-or-undefined", ["description<get>"]],
	[
		"Math",
		"number",
		[
			"abs",
			"acos",
			"acosh",
			"asin",
			"asinh",
			"atan",
			"atanh",
			"atan2",
			"cbrt",
			"ceil",
			"clz32",
			"cos",
			"cosh",
			"exp",
			"expm1",
			"floor",
			"fround",
			"f16round",
			"hypot",
			"imul",
			"log",
			"log1p",
			"log2",
			"log10",
			"max",
			"min",
			"pow",
			"random",
			"round",
			"sign",
			"sin",
			"sinh",
			"sqrt",
			"sumPrecise",
			"tan",
			"tanh",
			"trunc",
		],
	],
	[
		"Object.prototype",
		"boolean",
		["hasOwnProperty", "propertyIsEnumerable", "isPrototypeOf"],
	],
	["Object.prototype", "string", ["toString"]],
	["Object", "boolean", ["isExtensible", "isFrozen", "isSealed"]],
	["Function.prototype", "string", ["toString"]],
	["Function.prototype", "boolean", ["[%Symbol.hasInstance%]"]],
	["Error.prototype", "string", ["toString"]],
	[
		"Reflect",
		"boolean",
		[
			"defineProperty",
			"deleteProperty",
			"has",
			"isExtensible",
			"preventExtensions",
			"set",
			"setPrototypeOf",
		],
	],
	["String", "string", ["fromCharCode", "fromCodePoint", "raw"]],
	[
		"String.prototype",
		"string",
		[
			"valueOf",
			"toString",
			"charAt",
			"concat",
			"slice",
			"substring",
			"substr",
			"repeat",
			"padStart",
			"padEnd",
			"trim",
			"trimStart",
			"trimEnd",
			"trimLeft",
			"trimRight",
			"toLowerCase",
			"toUpperCase",
			"toLocaleLowerCase",
			"toLocaleUpperCase",
			"normalize",
			"toWellFormed",
			"anchor",
			"big",
			"blink",
			"bold",
			"fixed",
			"fontcolor",
			"fontsize",
			"italics",
			"link",
			"small",
			"strike",
			"sub",
			"sup",
		],
	],
	[
		"String.prototype",
		"number",
		["charCodeAt", "indexOf", "lastIndexOf", "localeCompare"],
	],
	["String.prototype", "boolean", ["includes", "startsWith", "endsWith", "isWellFormed"]],
	["String.prototype", "string-or-undefined", ["at"]],
	["String.prototype", "number-or-undefined", ["codePointAt"]],
	["Array.prototype", "boolean", ["includes"]],
	["Array.prototype", "number", ["indexOf", "lastIndexOf", "push", "unshift"]],
	["Array.prototype", "string", ["join", "toLocaleString"]],
	["ArrayBuffer.prototype", "number", ["byteLength<get>", "maxByteLength<get>"]],
	["ArrayBuffer.prototype", "boolean", ["detached<get>", "resizable<get>"]],
	["SharedArrayBuffer.prototype", "number", ["byteLength<get>", "maxByteLength<get>"]],
	["SharedArrayBuffer.prototype", "boolean", ["growable<get>"]],
	["DataView.prototype", "number", ["byteLength<get>", "byteOffset<get>"]],
	// The captured shared TypedArray prototype is first reached through Int8Array.
	["Int8Array.prototype.[[Prototype]]", "boolean", ["every", "some", "includes"]],
	[
		"Int8Array.prototype.[[Prototype]]",
		"number",
		[
			"byteLength<get>",
			"byteOffset<get>",
			"length<get>",
			"indexOf",
			"lastIndexOf",
			"findIndex",
			"findLastIndex",
		],
	],
	["Int8Array.prototype.[[Prototype]]", "string", ["join", "toLocaleString"]],
	["Map.prototype", "number", ["size<get>"]],
	["Set.prototype", "number", ["size<get>"]],
	["WeakMap.prototype", "boolean", ["has", "delete"]],
	["WeakSet.prototype", "boolean", ["has", "delete"]],
	["FinalizationRegistry.prototype", "boolean", ["unregister"]],
	["Iterator.prototype", "boolean", ["every", "some"]],
	[
		"Date.prototype",
		"number",
		[
			"valueOf",
			"getTime",
			"getFullYear",
			"getUTCFullYear",
			"getMonth",
			"getUTCMonth",
			"getDate",
			"getUTCDate",
			"getDay",
			"getUTCDay",
			"getHours",
			"getUTCHours",
			"getMinutes",
			"getUTCMinutes",
			"getSeconds",
			"getUTCSeconds",
			"getMilliseconds",
			"getUTCMilliseconds",
			"getTimezoneOffset",
			"getYear",
			"setTime",
			"setMilliseconds",
			"setUTCMilliseconds",
			"setSeconds",
			"setUTCSeconds",
			"setMinutes",
			"setUTCMinutes",
			"setHours",
			"setUTCHours",
			"setDate",
			"setUTCDate",
			"setMonth",
			"setUTCMonth",
			"setFullYear",
			"setUTCFullYear",
			"setYear",
		],
	],
	[
		"Date.prototype",
		"string",
		[
			"toString",
			"toDateString",
			"toTimeString",
			"toUTCString",
			"toGMTString",
			"toISOString",
			"toLocaleString",
			"toLocaleDateString",
			"toLocaleTimeString",
		],
	],
	["RegExp.prototype", "boolean", ["test"]],
	["RegExp.prototype", "string", ["toString", "flags<get>", "source<get>"]],
	[
		"RegExp.prototype",
		"boolean-or-undefined",
		[
			"dotAll<get>",
			"global<get>",
			"hasIndices<get>",
			"ignoreCase<get>",
			"multiline<get>",
			"sticky<get>",
			"unicode<get>",
			"unicodeSets<get>",
		],
	],
	["JSON", "string-or-undefined", ["stringify"]],
	["Atomics", "boolean", ["isLockFree"]],
	["Atomics", "number", ["notify"]],
	["Atomics", "string", ["wait"]],
	[
		"Atomics",
		"number-or-bigint",
		["add", "and", "compareExchange", "exchange", "load", "or", "store", "sub", "xor"],
	],
	[
		"",
		"object",
		[
			"Array",
			"Error",
			"EvalError",
			"RangeError",
			"ReferenceError",
			"SyntaxError",
			"TypeError",
			"URIError",
			"AggregateError",
		],
		false,
	],
	["", "object", ["Object", "RegExp"]],
	["", "object", ["Function"], true],
	["Object", "object", ["assign", "defineProperty", "defineProperties"]],
	[
		"Object",
		"object",
		[
			"create",
			"entries",
			"keys",
			"values",
			"fromEntries",
			"getOwnPropertyDescriptors",
			"getOwnPropertyNames",
			"getOwnPropertySymbols",
			"groupBy",
		],
		false,
	],
	["Object", "object-or-null", ["getPrototypeOf"]],
	["Object", "object-or-undefined", ["getOwnPropertyDescriptor"], false],
	["Object.prototype", "object", ["valueOf"]],
	["Reflect", "object", ["construct"]],
	["Reflect", "object", ["ownKeys"], false],
	["Reflect", "object-or-null", ["getPrototypeOf"]],
	["Reflect", "object-or-undefined", ["getOwnPropertyDescriptor"], false],
	["Array", "object", ["from", "fromAsync", "of"]],
	[
		"Array.prototype",
		"object",
		[
			"concat",
			"copyWithin",
			"fill",
			"filter",
			"flat",
			"flatMap",
			"map",
			"reverse",
			"slice",
			"sort",
			"splice",
		],
	],
	[
		"Array.prototype",
		"object",
		["entries", "keys", "values", "toReversed", "toSorted", "toSpliced", "with"],
		false,
	],
	["String.prototype", "object", ["[%Symbol.iterator%]"], false],
	[
		"Int8Array.prototype.[[Prototype]]",
		"object",
		[
			"buffer<get>",
			"copyWithin",
			"entries",
			"fill",
			"filter",
			"keys",
			"map",
			"reverse",
			"slice",
			"sort",
			"subarray",
			"toReversed",
			"toSorted",
			"values",
			"with",
		],
		false,
	],
	["Int8Array.prototype.[[Prototype]]", "undefined", ["forEach", "set"]],
	["TypedArray.prototype", "object", ["map", "filter"], false],
	["ArrayOrTypedArray.prototype", "object", ["map", "filter"]],
	[
		"ArrayBuffer.prototype",
		"object",
		["slice", "transfer", "transferToFixedLength"],
		false,
	],
	["ArrayBuffer.prototype", "undefined", ["resize"]],
	["SharedArrayBuffer.prototype", "object", ["slice"], false],
	["SharedArrayBuffer.prototype", "undefined", ["grow"]],
	["DataView.prototype", "object", ["buffer<get>"], false],
	["DataView.prototype", "number", ["getFloat16"]],
	["DataView.prototype", "bigint", ["getBigInt64", "getBigUint64"]],
	[
		"DataView.prototype",
		"undefined",
		[
			"setInt8",
			"setUint8",
			"setInt16",
			"setUint16",
			"setInt32",
			"setUint32",
			"setFloat16",
			"setFloat32",
			"setFloat64",
			"setBigInt64",
			"setBigUint64",
		],
	],
	["Map", "object", ["groupBy"], false],
	["Map.prototype", "object", ["set", "entries", "keys", "values"], false],
	["Map.prototype", "undefined", ["clear", "forEach"]],
	["Set.prototype", "object", ["add", "entries", "values", "keys"], false],
	["Set.prototype", "undefined", ["clear", "forEach"]],
	["WeakMap.prototype", "object", ["set"], false],
	["WeakSet.prototype", "object", ["add"], false],
	["WeakRef.prototype", "weak-value-or-undefined", ["deref"]],
	["FinalizationRegistry.prototype", "undefined", ["register"]],
	["Iterator", "object", ["from"]],
	[
		"Iterator.prototype",
		"object",
		["drop", "filter", "flatMap", "map", "take", "toArray"],
		false,
	],
	["Iterator.prototype", "undefined", ["forEach"]],
	["RegExp.prototype", "object-or-null", ["exec"], false],
	["RegExp.prototype", "object-or-null", ["[%Symbol.match%]"]],
	["RegExp.prototype", "object", ["[%Symbol.matchAll%]", "[%Symbol.split%]"], false],
	["RegExp.prototype", "string", ["[%Symbol.replace%]"]],
	["Function.prototype", "object", ["bind"], true],
	["Promise", "object", ["all", "allSettled", "any", "race", "reject", "resolve", "try"]],
	["Promise", "object", ["withResolvers"], false],
	["Proxy", "object", ["revocable"], false],
	["Promise.prototype", "object", ["then"]],
	["Atomics", "undefined", ["pause"]],
] as const) {
	for (const method of methods) {
		const operation =
			owner === "" ? method : `${owner}${method.startsWith("[") ? "" : "."}${method}`;
		normalResultKinds.set(operation, normalResultKindMasks[result]);
		if (callability !== undefined) normalResultCallabilities.set(operation, callability);
	}
}

normalResultKinds.set(
	"Symbol.prototype[%Symbol.toPrimitive%]",
	COMPILER_VALUE_KIND_SYMBOL,
);

for (const descriptor of builtinOperations) {
	const result = descriptor.result;
	if (
		result === "number" ||
		result === "boolean" ||
		result === "string" ||
		result === "bigint" ||
		result === "symbol" ||
		result === "undefined"
	)
		normalResultKinds.set(descriptor.id, normalResultKindMasks[result]);
}

// Normal-completion facts do not license removing coercion, protocol calls, or throws.
export function builtinNormalResultKinds(
	operation: string,
): CompilerValueKindMask | undefined {
	return normalResultKinds.get(operation);
}

// IsCallable of the returned value says nothing about invocation errors or reentry.
export function builtinNormalResultCallability(operation: string): boolean | undefined {
	const callability = normalResultCallabilities.get(operation);
	if (callability !== undefined) return callability;
	const kinds = normalResultKinds.get(operation);
	return kinds !== undefined && (kinds & COMPILER_VALUE_KIND_OBJECT) === 0
		? false
		: undefined;
}

export type BuiltinNormalResultProjection = (
	| { readonly kind: "receiver" }
	| { readonly kind: "argument"; readonly index: number }
) & {
	// Boxing and unboxing preserve identity only for these input kinds.
	readonly identityKinds?: CompilerValueKindMask;
};

const firstArgumentResult = { kind: "argument", index: 0 } as const;
const receiverResult = { kind: "receiver" } as const;
const objectReceiverResult = {
	...receiverResult,
	identityKinds: COMPILER_VALUE_KIND_OBJECT,
};
const objectArgumentResult = {
	...firstArgumentResult,
	identityKinds: COMPILER_VALUE_KIND_OBJECT,
};
const normalResultProjections: ReadonlyMap<string, BuiltinNormalResultProjection> =
	new Map<string, BuiltinNormalResultProjection>([
		...[
			"Object.freeze",
			"Object.seal",
			"Object.preventExtensions",
			"Object.setPrototypeOf",
			"Object.defineProperty",
			"Object.defineProperties",
		].map((operation) => [operation, firstArgumentResult] as const),
		...[
			"Map.prototype.set",
			"Set.prototype.add",
			"WeakMap.prototype.set",
			"WeakSet.prototype.add",
			"Int8Array.prototype.[[Prototype]].copyWithin",
			"Int8Array.prototype.[[Prototype]].fill",
			"Int8Array.prototype.[[Prototype]].reverse",
			"Int8Array.prototype.[[Prototype]].sort",
		].map((operation) => [operation, receiverResult] as const),
		...[
			"Object.prototype.valueOf",
			"Array.prototype.copyWithin",
			"Array.prototype.fill",
			"Array.prototype.reverse",
			"Array.prototype.sort",
		].map((operation) => [operation, objectReceiverResult] as const),
		...["Object", "Object.assign"].map(
			(operation) => [operation, objectArgumentResult] as const,
		),
		...(
			[
				["Number.prototype.valueOf", COMPILER_VALUE_KIND_NUMBER],
				["Boolean.prototype.valueOf", COMPILER_VALUE_KIND_BOOLEAN],
				["String.prototype.valueOf", COMPILER_VALUE_KIND_STRING],
				["String.prototype.toString", COMPILER_VALUE_KIND_STRING],
				["BigInt.prototype.valueOf", COMPILER_VALUE_KIND_BIGINT],
				["Symbol.prototype.valueOf", COMPILER_VALUE_KIND_SYMBOL],
				["Symbol.prototype[%Symbol.toPrimitive%]", COMPILER_VALUE_KIND_SYMBOL],
			] as const
		).map(
			([operation, identityKinds]) =>
				[operation, { ...receiverResult, identityKinds }] as const,
		),
	]);

export function builtinNormalResultProjection(
	operation: string,
): BuiltinNormalResultProjection | undefined {
	return normalResultProjections.get(operation);
}

// Integer payload identity does not remove callee checks, coercion or argument effects.
export function builtinPreservesIntegerInput(operation: string): boolean {
	return (
		operation === "Math.floor" ||
		operation === "Math.ceil" ||
		operation === "Math.trunc" ||
		operation === "Math.round"
	);
}

export function builtinResultIsInt32(operation: string): boolean {
	return operation === "Math.imul" || operation === "Math.clz32";
}

export function builtinOperationDescriptor(
	id: string,
): BuiltinOperationDescriptor | undefined {
	return builtinOperations.find((operation) => operation.id === id);
}

export function builtinCallbackInvocation(
	id: string,
): BuiltinOperationDescriptor["callback"] {
	const descriptor = builtinOperationDescriptor(id);
	const invocation = descriptor?.callback;
	if (invocation === undefined) return undefined;
	if (
		descriptor?.guardedCallees?.some((callee) => {
			const member = builtinOperationDescriptor(callee);
			return (
				member?.guardedCallees !== undefined ||
				member?.callback === undefined ||
				member.callback.kind !== invocation.kind ||
				member.callback.argumentIndex !== invocation.argumentIndex ||
				member.callback.argumentKinds.length !== invocation.argumentKinds.length ||
				member.callback.argumentKinds.some(
					(kind, index) =>
						invocation.argumentKinds[index] !== "any" &&
						kind !== invocation.argumentKinds[index],
				)
			);
		})
	)
		return undefined;
	return invocation;
}

// Family member numeric roles nominate guarded adapters, never unconditional argument facts.
export function builtinCallbackNumberArgumentCandidates(
	id: string,
): ReadonlyArray<number> {
	const invocation = builtinCallbackInvocation(id);
	if (invocation === undefined) return [];
	const members = builtinOperationDescriptor(id)?.guardedCallees ?? [];
	return invocation.argumentKinds.flatMap((kind, index) =>
		kind === "number" ||
		(kind === "any" &&
			members.some(
				(member) =>
					builtinOperationDescriptor(member)?.callback?.argumentKinds[index] === "number",
			))
			? [index]
			: [],
	);
}

function featureGuard(feature: BuiltinFeature): string {
	switch (feature) {
		case "always":
			return "1";
		// These slots and global bindings exist as disabled stubs/undefined values;
		// only features that remove enum members need a preprocessor guard.
		case "eval":
			return "1";
		case "realms":
			return "MAL_REALMS";
		case "regexp":
			return "1";
		case "temporal":
			return "MAL_TEMPORAL";
		case "intl":
			return "1";
	}
}

/** Deterministic generated input shared with the C Realm finalizer. */
export function generatePrimordialRegistryInclude(): string {
	const lines = [
		"/* Generated by scripts/generate-builtin-registry.ts. Do not edit. */",
		"#ifdef MAL_PRIMORDIAL_GLOBAL",
	];
	for (const binding of primordialGlobalBindings) {
		lines.push(`#if ${featureGuard(binding.feature)}`);
		lines.push(
			`MAL_PRIMORDIAL_GLOBAL(${JSON.stringify(binding.name)}, ${binding.intrinsic})`,
		);
		lines.push("#endif");
	}
	lines.push("#undef MAL_PRIMORDIAL_GLOBAL", "#endif", "");
	lines.push("#ifdef MAL_PRIMORDIAL_EXCLUDED_INTRINSIC");
	for (const intrinsic of primordialObjectPolicy.excludedIntrinsics) {
		lines.push(`MAL_PRIMORDIAL_EXCLUDED_INTRINSIC(${intrinsic})`);
	}
	lines.push("#undef MAL_PRIMORDIAL_EXCLUDED_INTRINSIC", "#endif", "");
	lines.push("#ifdef MAL_DIRECT_BUILTIN_OP");
	for (const operation of directBuiltinOperationIds) {
		lines.push(
			`MAL_DIRECT_BUILTIN_OP(${exactBuiltinCallDescriptors[operation].cOperation})`,
		);
	}
	lines.push("#undef MAL_DIRECT_BUILTIN_OP", "#endif", "");
	return lines.join("\n");
}

export function validateBuiltinRegistry(): void {
	const globalNames = new Set<string>();
	for (const binding of primordialGlobalBindings) {
		if (globalNames.has(binding.name))
			throw new Error(`duplicate primordial global: ${binding.name}`);
		globalNames.add(binding.name);
	}
	const operationIds = new Set<string>();
	for (const operation of builtinOperations) {
		if (operationIds.has(operation.id))
			throw new Error(`duplicate builtin operation: ${operation.id}`);
		operationIds.add(operation.id);
		if (
			operation.guardedCallees !== undefined &&
			(operation.guardedCallees.length < 2 ||
				builtinCallbackInvocation(operation.id) === undefined ||
				operation.guardedCallees.some(
					(callee) => builtinOperationDescriptor(callee)?.key !== operation.key,
				))
		)
			throw new Error(`invalid builtin callback family: ${operation.id}`);
	}
	for (const operation of directBuiltinOperationIds) {
		const descriptor = builtinOperationDescriptor(operation);
		if (descriptor === undefined)
			throw new Error(`direct builtin operation lacks semantics: ${operation}`);
		if (!descriptor.lowerings.includes("exact-builtin-call"))
			throw new Error(`direct builtin operation lacks exact lowering: ${operation}`);
	}
}
