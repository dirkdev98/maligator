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
	readonly observation: "readonly" | "elements" | "receiver" | "mutation" | "callback";
}

const methods: Readonly<Record<LiteralReceiverKind, ReadonlyArray<LiteralPrototypeKey>>> =
	{
		object: [
			"__defineGetter__",
			"__defineSetter__",
			"__lookupGetter__",
			"__lookupSetter__",
			"constructor",
			"hasOwnProperty",
			"isPrototypeOf",
			"propertyIsEnumerable",
			"toLocaleString",
			"toString",
			"valueOf",
		],
		array: [
			Symbol.iterator,
			"at",
			"concat",
			"constructor",
			"copyWithin",
			"entries",
			"every",
			"fill",
			"filter",
			"find",
			"findIndex",
			"findLast",
			"findLastIndex",
			"flat",
			"flatMap",
			"forEach",
			"includes",
			"indexOf",
			"join",
			"keys",
			"lastIndexOf",
			"map",
			"pop",
			"push",
			"reduce",
			"reduceRight",
			"reverse",
			"shift",
			"slice",
			"some",
			"sort",
			"splice",
			"toLocaleString",
			"toReversed",
			"toSorted",
			"toSpliced",
			"toString",
			"unshift",
			"values",
			"with",
		],
		string: [
			Symbol.iterator,
			"anchor",
			"at",
			"big",
			"blink",
			"bold",
			"charAt",
			"charCodeAt",
			"codePointAt",
			"concat",
			"constructor",
			"endsWith",
			"fixed",
			"fontcolor",
			"fontsize",
			"includes",
			"indexOf",
			"isWellFormed",
			"italics",
			"lastIndexOf",
			"link",
			"localeCompare",
			"match",
			"matchAll",
			"normalize",
			"padEnd",
			"padStart",
			"repeat",
			"replace",
			"replaceAll",
			"search",
			"slice",
			"small",
			"split",
			"startsWith",
			"strike",
			"sub",
			"substr",
			"substring",
			"sup",
			"toLocaleLowerCase",
			"toLocaleUpperCase",
			"toLowerCase",
			"toString",
			"toUpperCase",
			"toWellFormed",
			"trim",
			"trimEnd",
			"trimLeft",
			"trimRight",
			"trimStart",
			"valueOf",
		],
		number: [
			"constructor",
			"toExponential",
			"toFixed",
			"toLocaleString",
			"toPrecision",
			"toString",
			"valueOf",
		],
		boolean: ["constructor", "toString", "valueOf"],
		bigint: ["constructor", "toLocaleString", "toString", "valueOf"],
	};

const arrayReadonly = new Set<LiteralPrototypeKey>([
	"includes",
	"indexOf",
	"lastIndexOf",
	"join",
	"toString",
	"toLocaleString",
	"keys",
	"constructor",
]);
const arrayCopies = new Set<LiteralPrototypeKey>([
	"at",
	"slice",
	"concat",
	"flat",
	"with",
	"toReversed",
	"toSorted",
	"toSpliced",
	"values",
	"entries",
	Symbol.iterator,
]);
const arrayMutations = new Set<LiteralPrototypeKey>([
	"copyWithin",
	"fill",
	"pop",
	"push",
	"reverse",
	"shift",
	"sort",
	"splice",
	"unshift",
]);

function observation(
	receiver: LiteralReceiverKind,
	key: LiteralPrototypeKey,
): LiteralPrototypeMethod["observation"] {
	if (receiver !== "array" && receiver !== "object") return "readonly";
	if (receiver === "array") {
		if (arrayReadonly.has(key)) return "readonly";
		if (arrayCopies.has(key)) return "elements";
		if (arrayMutations.has(key)) return "mutation";
		return "callback";
	}
	if (key === "valueOf") return "receiver";
	if (key === "__defineGetter__" || key === "__defineSetter__") return "mutation";
	return "readonly";
}

export const literalPrototypeMethods: ReadonlyArray<LiteralPrototypeMethod> =
	Object.entries(methods).flatMap(([receiver, keys]) =>
		keys.map((key) => ({
			receiver: receiver as LiteralReceiverKind,
			key,
			prototype: `MAL_INTRINSIC_${receiver.toUpperCase()}_PROTOTYPE`,
			observation: observation(receiver as LiteralReceiverKind, key),
		})),
	);

export function literalPrototypeMethodIndex(
	receiver: LiteralReceiverKind,
	key: LiteralPrototypeKey,
): number | undefined {
	let index = literalPrototypeMethods.findIndex(
		(method) => method.receiver === receiver && method.key === key,
	);
	if (index < 0)
		index = literalPrototypeMethods.findIndex(
			(method) => method.receiver === "object" && method.key === key,
		);
	return index < 0 ? undefined : index;
}

export function generateLiteralPrototypeMethods(): string {
	const lines = literalPrototypeMethods.map(
		(method, index) =>
			`MAL_LITERAL_METHOD(${index}, ${method.prototype}, ${JSON.stringify(method.key === Symbol.iterator ? "@@iterator" : method.key)})`,
	);
	return `${lines.join("\n")}\n`;
}
