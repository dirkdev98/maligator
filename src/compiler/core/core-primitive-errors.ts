import { mathUnaryOperationKeys } from "../shared/builtin-registry.ts";
import { evaluateConstantBuiltin } from "../shared/constant-builtins.ts";
import type { KnownBuiltinError } from "../shared/known-builtin-errors.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";

const primitives = new Set([
	"undefined",
	"null",
	"boolean",
	"number",
	"string",
	"bigint",
	"symbol",
]);
const unaryNumber = new Set<string>([
	...mathUnaryOperationKeys.map(([operation]) => operation),
	"Math.f16round",
	"isNaN",
	"isFinite",
]);
const binaryNumber = new Set(["Math.pow", "Math.atan2", "Math.imul"]);
const variadicNumber = new Set([
	"Math.min",
	"Math.max",
	"Math.hypot",
	"String.fromCharCode",
	"String.fromCodePoint",
]);
const stringProtocols = new Set([
	"match",
	"matchAll",
	"search",
	"replace",
	"replaceAll",
	"split",
]);
const nullishStringErrors = new Map<string, KnownBuiltinError>([
	["matchAll", "stringMatchAllNullish"],
	["split", "stringSplitNullish"],
	["replace", "stringReplaceNullish"],
	["replaceAll", "stringReplaceAllNullish"],
]);
const receiverErrors = [
	["Number", "numberReceiver"],
	["Boolean", "booleanReceiver"],
	["BigInt", "bigintReceiver"],
	["Symbol", "symbolReceiver"],
] as const;

export function corePrimitiveBuiltinError(
	analysis: CoreStaticValueAnalysis,
	instruction: CoreInstructionId,
	operation: string,
	inputs: ReadonlyArray<CoreValueId>,
	construct = false,
): KnownBuiltinError | undefined {
	const brand = (value: CoreValueId | undefined) => {
		if (value === undefined) return "undefined";
		const fact = analysis.queryAt(value, instruction);
		return fact.kind === "known" && primitives.has(fact.brand) ? fact.brand : undefined;
	};
	const receiver = brand(inputs[0]),
		first = brand(inputs[1]);
	const receiverMismatch = (expected: string): boolean => {
		if (receiver !== undefined) return receiver !== expected.toLowerCase();
		const fact = analysis.queryAt(inputs[0]!, instruction);
		return (
			fact.kind === "known" &&
			(fact.brand === "array" ||
				fact.brand === "function" ||
				(fact.brand === "object" &&
					fact.exactBrand !== undefined &&
					fact.exactBrand !== expected))
		);
	};
	if (construct) {
		if (operation === "Number" && first === "symbol") return "symbolNumber";
		if (operation === "String" && first === "symbol") return "symbolString";
		return undefined;
	}
	for (const [owner, error] of receiverErrors) {
		if (
			(operation.startsWith(`${owner}.prototype.`) ||
				operation.startsWith(`${owner}.prototype[`)) &&
			receiverMismatch(owner)
		)
			return error;
	}
	if (operation.startsWith("String.prototype.")) {
		const method = operation.slice("String.prototype.".length);
		if (method === "valueOf" || method === "toString") {
			if (receiverMismatch("String")) return "stringReceiver";
		} else {
			if (receiver === "null" || receiver === "undefined")
				return nullishStringErrors.get(method) ?? "stringNullish";
			// Protocol dispatch can consume the original receiver before ToString.
			if (receiver === "symbol" && (!stringProtocols.has(method) || first !== undefined))
				return "symbolString";
		}
	}
	if (operation === "Number" && first === "symbol") return "symbolNumber";
	if (operation === "BigInt" && first === "symbol") return "bigintValue";
	if ((operation === "Symbol" || operation === "Symbol.for") && first === "symbol")
		return "symbolString";
	if (operation === "Symbol.keyFor" && first !== undefined && first !== "symbol")
		return "symbolKey";
	if (operation === "Math.sumPrecise") {
		if (first === "null" || first === "undefined") return "readNullish";
		if (first !== undefined && first !== "string") return "notIterable";
	}
	if (operation === "String.raw" && (first === "null" || first === "undefined"))
		return "readNullish";
	if (
		[
			"parseInt",
			"parseFloat",
			"Number.parseInt",
			"Number.parseFloat",
			"encodeURI",
			"encodeURIComponent",
			"decodeURI",
			"decodeURIComponent",
			"escape",
			"unescape",
			"globalThis.escape",
			"globalThis.unescape",
		].includes(operation) &&
		first === "symbol"
	)
		return "symbolString";
	const numeric = (kind: string | undefined): KnownBuiltinError | null | undefined =>
		kind === "symbol"
			? "symbolNumber"
			: kind === "bigint"
				? "bigintNumberConversion"
				: kind === undefined
					? undefined
					: null;
	let start = 1,
		count = 0;
	if (unaryNumber.has(operation)) count = 1;
	else if (binaryNumber.has(operation)) count = 2;
	else if (variadicNumber.has(operation)) count = inputs.length - 1;
	else if (
		(operation === "parseInt" || operation === "Number.parseInt") &&
		first !== undefined &&
		first !== "symbol"
	) {
		start = 2;
		count = 1;
	} else if (
		([
			"Number.prototype.toString",
			"Number.prototype.toFixed",
			"Number.prototype.toExponential",
			"Number.prototype.toPrecision",
		].includes(operation) &&
			receiver === "number") ||
		(operation === "BigInt.prototype.toString" && receiver === "bigint")
	)
		count = 1;
	else if (operation === "BigInt.asIntN" || operation === "BigInt.asUintN") count = 1;
	if (count > 4096) return undefined;
	for (let index = start; index < start + count; index++) {
		const error = numeric(brand(inputs[index]));
		if (error !== null) return error;
		if (
			operation === "String.fromCodePoint" &&
			index + 1 < start + count &&
			evaluateConstantBuiltin(operation, undefined, [
				inputs[index] === undefined
					? { kind: "undefined" }
					: analysis.constant(inputs[index]!, instruction),
			]).kind !== "value"
		)
			return undefined;
	}
	if (
		(operation === "BigInt.asIntN" || operation === "BigInt.asUintN") &&
		["undefined", "null", "number", "symbol"].includes(brand(inputs[2]) ?? "") &&
		evaluateConstantBuiltin(operation, undefined, [
			inputs[1] === undefined
				? { kind: "undefined" }
				: analysis.constant(inputs[1], instruction),
			{ kind: "bigint", value: 0n },
		]).kind === "value"
	)
		return "bigintValue";
	return undefined;
}
