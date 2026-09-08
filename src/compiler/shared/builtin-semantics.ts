export type BuiltinPrimitiveResult =
	| "number"
	| "string"
	| "boolean"
	| "bigint"
	| "symbol"
	| "number-or-undefined"
	| "string-or-undefined";

const primitiveResults = new Map<string, BuiltinPrimitiveResult>();
for (const [owner, result, methods] of [
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
	["", "symbol", ["Symbol"]],
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
	["Symbol", "symbol", ["for"]],
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
] as const) {
	for (const method of methods)
		primitiveResults.set(owner === "" ? method : `${owner}.${method}`, result);
}

primitiveResults.set("Symbol.prototype[%Symbol.toPrimitive%]", "symbol");

// Normal-completion facts do not license removing coercion, protocol calls, or throws.
export function builtinPrimitiveResult(
	operation: string,
): BuiltinPrimitiveResult | undefined {
	return primitiveResults.get(operation);
}

export type SemanticCondition =
	| "always"
	| "object-receiver"
	| "object-argument"
	| "object-element"
	| "callback-present"
	| "custom-species"
	| "custom-protocol"
	| "nonempty-receiver";

export interface SemanticStep {
	readonly kind:
		| "coerce"
		| "check"
		| "read"
		| "call"
		| "write"
		| "allocate"
		| "retain"
		| "environment";
	readonly subject: string;
	readonly when: SemanticCondition | ReadonlyArray<SemanticCondition>;
	readonly exposes: "none" | "elements" | "receiver";
}

export interface BuiltinInvocationSummary {
	readonly argumentEvaluation: "receiver-key-arguments-before-invocation";
	readonly steps: ReadonlyArray<SemanticStep>;
	readonly result:
		| "primitive"
		| "receiver-alias"
		| "element-alias"
		| "fresh-array"
		| "fresh-iterator"
		| "unknown";
	readonly mayThrow: boolean;
	readonly mayGC: boolean;
	readonly maySuspend: boolean;
	readonly mayEnqueueJob: boolean;
	readonly complete: boolean;
}

const summaryCache = new Map<string, BuiltinInvocationSummary>();

export function builtinInvocationSummary(
	owner: string,
	key: string,
): BuiltinInvocationSummary {
	const id = `${owner}.${key}`;
	const cached = summaryCache.get(id);
	if (cached !== undefined) return cached;
	const steps: Array<SemanticStep> = [];
	const step = (
		kind: SemanticStep["kind"],
		subject: string,
		when: SemanticStep["when"] = "always",
		exposes: SemanticStep["exposes"] = "none",
	) => steps.push({ kind, subject, when, exposes });
	let result: BuiltinInvocationSummary["result"] = "unknown";
	let complete = true;
	if (owner === "Array.prototype") {
		step("coerce", "receiver:ToObject", "object-receiver");
		if (!["keys", "values", "entries", "Symbol.iterator", "toString"].includes(key))
			step("read", "receiver.length");
		if (["includes", "indexOf", "lastIndexOf"].includes(key)) {
			step("coerce", "argument[1]:ToIntegerOrInfinity", [
				"nonempty-receiver",
				"object-argument",
			]);
			step("read", key === "includes" ? "indexed:Get" : "indexed:HasProperty-then-Get");
			result = "primitive";
		} else if (key === "toString") {
			step("read", "receiver.join", "custom-protocol", "receiver");
			step(
				"call",
				"receiver.join or Object.prototype.toString",
				"custom-protocol",
				"receiver",
			);
			result = "unknown";
		} else if (["join", "toLocaleString"].includes(key)) {
			if (key === "join") step("coerce", "argument[0]:ToString", "object-argument");
			if (key === "toLocaleString") step("environment", "element locale formatting");
			step("read", "indexed:Get");
			step(
				key === "toLocaleString" ? "call" : "coerce",
				key === "toLocaleString" ? "element.toLocaleString" : "element:ToString",
				"object-element",
				"elements",
			);
			result = "primitive";
		} else if (["keys", "values", "entries", "Symbol.iterator"].includes(key)) {
			step("allocate", "iterator");
			step(
				"retain",
				"receiver until iterator exhaustion",
				"always",
				key === "keys" ? "none" : "elements",
			);
			result = "fresh-iterator";
		} else if (
			[
				"at",
				"slice",
				"concat",
				"flat",
				"with",
				"toReversed",
				"toSorted",
				"toSpliced",
			].includes(key)
		) {
			step("coerce", "index/depth/count arguments", "object-argument");
			if (["slice", "concat", "flat"].includes(key)) {
				step("read", "receiver.constructor[Symbol.species]", "custom-species");
				step("call", "species constructor", "custom-species");
			}
			if (key === "concat")
				step("read", "items[Symbol.isConcatSpreadable]", "custom-protocol");
			step("read", "indexed elements");
			if (key === "toSorted")
				step("call", "comparator(element, element) or ToString", "always", "elements");
			if (key !== "at") step("allocate", "fresh result");
			step("retain", "result elements", "always", "elements");
			result = key === "at" ? "element-alias" : "fresh-array";
		} else if (
			[
				"map",
				"filter",
				"flatMap",
				"forEach",
				"some",
				"every",
				"find",
				"findIndex",
				"findLast",
				"findLastIndex",
				"reduce",
				"reduceRight",
			].includes(key)
		) {
			step("check", "callback:IsCallable");
			if (["map", "filter", "flatMap"].includes(key)) {
				step("read", "receiver.constructor[Symbol.species]", "custom-species");
				step("call", "ArraySpeciesCreate", "custom-species");
				step("allocate", "fresh result");
				result = "fresh-array";
			}
			step("read", "indexed:HasProperty/Get in iteration order");
			step(
				"call",
				"callback(value, index, receiver); reduce also accumulator",
				"always",
				"receiver",
			);
			if (["find", "findLast"].includes(key)) result = "element-alias";
			if (["forEach", "some", "every", "findIndex", "findLastIndex"].includes(key))
				result = "primitive";
		} else if (
			[
				"push",
				"pop",
				"shift",
				"unshift",
				"splice",
				"sort",
				"reverse",
				"fill",
				"copyWithin",
			].includes(key)
		) {
			step("coerce", "arguments", "object-argument");
			if (key === "sort")
				step("call", "comparator(element, element) or ToString", "always", "elements");
			step("write", "receiver indexed properties and length");
		} else complete = false;
	} else if (owner === "Object.prototype") {
		if (key === "valueOf") {
			result = "receiver-alias";
			step("retain", "ToObject(receiver)", "always", "receiver");
		} else if (["__defineGetter__", "__defineSetter__"].includes(key))
			step("write", "receiver descriptor");
		else if (key === "toLocaleString") {
			step("call", "receiver.toString", "custom-protocol", "receiver");
			result = "unknown";
		} else if (
			[
				"hasOwnProperty",
				"propertyIsEnumerable",
				"__lookupGetter__",
				"__lookupSetter__",
			].includes(key)
		) {
			step("coerce", "argument[0]:ToPropertyKey", "object-argument");
			step(
				"read",
				"own descriptor/prototype chain; proxy internal methods",
				"custom-protocol",
			);
			result = key.startsWith("__") ? "unknown" : "primitive";
		} else if (key === "toString" || key === "isPrototypeOf") {
			step(
				"read",
				key === "toString" ? "receiver[Symbol.toStringTag]" : "argument prototype chain",
				"custom-protocol",
			);
			result = "primitive";
		} else complete = false;
	} else if (
		[
			"String.prototype",
			"Number.prototype",
			"Boolean.prototype",
			"BigInt.prototype",
		].includes(owner)
	) {
		step("coerce", "receiver brand or primitive conversion", "object-receiver");
		step("coerce", "operation arguments in specification order", "object-argument");
		if (["match", "matchAll", "replace", "replaceAll", "search", "split"].includes(key))
			step("call", "argument symbol protocol/replacer", "custom-protocol");
		if (/Locale|locale|normalize|UpperCase|LowerCase/.test(key))
			step("environment", "Unicode or locale data");
		result = "primitive";
		if (key === "split") {
			step("allocate", "split result");
			result = "fresh-array";
		}
		if (key === "Symbol.iterator" || key === "matchAll") {
			step("allocate", "iterator");
			result = "fresh-iterator";
		}
		if (["match", "matchAll", "replace", "replaceAll", "search", "split"].includes(key))
			result = "unknown";
		if (key === "constructor") complete = false;
	} else if (owner === "JSON") {
		step(
			"call",
			"toJSON then replacer; parse reviver post-order",
			"custom-protocol",
			"receiver",
		);
		step("read", "ordered own keys and property values");
		step("allocate", "serialization or parsed graph");
	} else complete = false;
	const mayInvokeUserCode = steps.some(
		(step) => step.kind === "call" || step.kind === "coerce" || step.kind === "read",
	);
	const summary: BuiltinInvocationSummary = {
		argumentEvaluation: "receiver-key-arguments-before-invocation",
		steps,
		result,
		mayThrow: true,
		mayGC: true,
		maySuspend: !complete || mayInvokeUserCode,
		mayEnqueueJob: !complete || mayInvokeUserCode,
		complete,
	};
	summaryCache.set(id, summary);
	return summary;
}

export function invocationPreservesPrivateReceiver(
	summary: BuiltinInvocationSummary,
	shallow: boolean,
): boolean {
	return (
		summary.complete &&
		summary.steps.every(
			(step) =>
				step.kind !== "write" &&
				step.exposes !== "receiver" &&
				(step.exposes !== "elements" || shallow),
		)
	);
}
