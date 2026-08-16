import type { EffectKind } from "./compiler-facts.ts";

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
	readonly receiver: "none" | "any" | "array" | "string" | "regexp" | "map" | "set";
	readonly arity: { readonly minimum: number; readonly maximum?: number };
	readonly evaluationOrder: "receiver-then-arguments" | "arguments-left-to-right";
	readonly coercionOrder: ReadonlyArray<string>;
	readonly effects: ReadonlyArray<EffectKind>;
	readonly result: string;
	readonly realm: "semantic-identity" | "realm-object-identity";
	readonly lowerings: ReadonlyArray<string>;
	/** Exact argument count currently accepted by the unboxed numeric lowering. */
	readonly nativeNumberArity?: number;
}

export type ExactBuiltinReceiverProof =
	| "exact-fresh-array"
	| "exact-fresh-map"
	| "intrinsic-object"
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
		receiverProof: "exact-fresh-array",
		cOperation: "MAL_DIRECT_BUILTIN_ARRAY_PUSH",
	},
	"Object.hasOwn": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 2,
		cOperation: "MAL_DIRECT_BUILTIN_OBJECT_HAS_OWN",
	},
	"String.prototype.charCodeAt": {
		receiverProof: "primitive-string",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_STRING_CHAR_CODE_AT",
	},
	"Map.prototype.get": {
		receiverProof: "exact-fresh-map",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_MAP_GET",
	},
	"Map.prototype.set": {
		receiverProof: "exact-fresh-map",
		forwardedArgumentLimit: 2,
		cOperation: "MAL_DIRECT_BUILTIN_MAP_SET",
	},
	"Object.keys": {
		receiverProof: "intrinsic-object",
		forwardedArgumentLimit: 1,
		cOperation: "MAL_DIRECT_BUILTIN_OBJECT_KEYS",
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
	excludedIntrinsics: ["MAL_INTRINSIC_GLOBAL_THIS", "MAL_INTRINSIC_CONSOLE"] as const,
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
	mathBinaryOperationKeys.map(
		([id, key]): BuiltinOperationDescriptor => ({
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
		}),
	);

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
).map(
	([key, result, allocates]): BuiltinOperationDescriptor => ({
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
	}),
);

export const builtinOperations: ReadonlyArray<BuiltinOperationDescriptor> = [
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
	...(["get", "set"] as const).map(
		(key): BuiltinOperationDescriptor => ({
			id: `Map.prototype.${key}`,
			owner: "Map.prototype",
			key,
			receiver: "map",
			arity: { minimum: key === "get" ? 1 : 2, maximum: key === "get" ? 1 : 2 },
			evaluationOrder: "receiver-then-arguments",
			coercionOrder: [],
			effects: ["throw", "safepoint"],
			result: key === "get" ? "any" : "receiver",
			realm: "semantic-identity",
			lowerings: ["generic", "guarded-native-collection", "exact-builtin-call"],
		}),
	),
	{
		id: "Set.prototype.add",
		owner: "Set.prototype",
		key: "add",
		receiver: "set",
		arity: { minimum: 1, maximum: 1 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: [],
		effects: ["throw", "safepoint"],
		result: "receiver",
		realm: "semantic-identity",
		lowerings: ["generic", "guarded-native-collection"],
	},
	{
		id: "String.prototype.slice",
		owner: "String.prototype",
		key: "slice",
		receiver: "string",
		arity: { minimum: 0, maximum: 2 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: ["receiver-string", "start-integer", "end-integer"],
		effects: ["coerce", "allocate", "throw", "safepoint"],
		result: "string",
		realm: "semantic-identity",
		lowerings: ["generic", "number-consumer-fusion"],
	},
	{
		id: "String.prototype.trim",
		owner: "String.prototype",
		key: "trim",
		receiver: "string",
		arity: { minimum: 0, maximum: 0 },
		evaluationOrder: "receiver-then-arguments",
		coercionOrder: ["receiver-string"],
		effects: ["coerce", "allocate", "throw", "safepoint"],
		result: "string",
		realm: "semantic-identity",
		lowerings: ["generic", "split-cursor-span"],
	},
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
	...mathOperations,
	...mathBinaryOperations,
];

export function builtinOperationDescriptor(
	id: string,
): BuiltinOperationDescriptor | undefined {
	return builtinOperations.find((operation) => operation.id === id);
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
	}
	for (const operation of directBuiltinOperationIds) {
		const descriptor = builtinOperationDescriptor(operation);
		if (descriptor === undefined)
			throw new Error(`direct builtin operation lacks semantics: ${operation}`);
		if (!descriptor.lowerings.includes("exact-builtin-call"))
			throw new Error(`direct builtin operation lacks exact lowering: ${operation}`);
	}
}
