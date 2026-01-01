import { EngineValueUtils, EngineValue } from "../data-types.ts";
import { normalCompletion, throwCompletion } from "./completion-record.ts";
import type { CompletionRecord } from "./completion-record.ts";
import type { PropertyKey } from "./property-map.ts";

// https://tc39.es/ecma262/#sec-toprimitive
export function toPrimitive(
	_input: EngineValue,
	_hint?: "default" | "string" | "number",
): CompletionRecord<EngineValue> {
	throw new Error(
		"Not implemented. Requires GetMethod, Call and other abstract operations.",
	);
}

// https://tc39.es/ecma262/#sec-ordinarytoprimitive
export function ordinaryToPrimitive(
	_input: EngineValue,
	_hint: "string" | "number",
): CompletionRecord<EngineValue> {
	throw new Error("Not implemented. Requires Get, Call and other abstract operations.");
}

// https://tc39.es/ecma262/#sec-toboolean
export function toBoolean(argument: EngineValue): EngineValue<"boolean"> {
	if (argument.isBoolean()) {
		return argument;
	}

	if (argument.isUndefined() || argument.isNull()) {
		return EngineValue.boolean(false);
	}

	if (
		argument.isNumber() &&
		(EngineValueUtils.isPositiveOrNegativeZero(argument) || isNaN(argument.data.value))
	) {
		return EngineValue.boolean(false);
	}

	if (argument.isBigInt() && argument.data.value === 0n) {
		return EngineValue.boolean(false);
	}

	if (argument.isString() && argument.data.value === "") {
		return EngineValue.boolean(false);
	}

	return EngineValue.boolean(true);
}

// https://tc39.es/ecma262/#sec-tonumeric
export function toNumeric(
	argument: EngineValue,
): CompletionRecord<EngineValue<"number" | "bigint">> {
	const primValue = toPrimitive(argument, "number");
	if (primValue.type === "throw") {
		return primValue;
	}

	const primitive = primValue.value;

	if (primitive.isBigInt()) {
		return normalCompletion(primitive);
	}

	return toNumber(primitive);
}

// https://tc39.es/ecma262/#sec-tonumber
export function toNumber(argument: EngineValue): CompletionRecord<EngineValue<"number">> {
	if (argument.isNumber()) {
		return normalCompletion(argument);
	}

	if (argument.isSymbol()) {
		// TODO: Error handling
		return throwCompletion(new TypeError("Cannot convert a Symbol value to a number"));
	}

	if (argument.isBigInt()) {
		// TODO: Error handling
		return throwCompletion(new TypeError("Cannot convert a BigInt value to a number"));
	}

	if (argument.isUndefined()) {
		return normalCompletion(EngineValue.number(NaN));
	}

	if (argument.isNull() || (argument.isBoolean() && argument.data.value === false)) {
		return normalCompletion(EngineValue.number(0));
	}

	if (argument.isBoolean() && argument.data.value === true) {
		return normalCompletion(EngineValue.number(1));
	}

	if (argument.isString()) {
		return normalCompletion(stringToNumber(argument.data.value));
	}

	const primValue = toPrimitive(argument, "number");
	return primValue.type === "throw" ? primValue : toNumber(primValue.value);
}

// https://tc39.es/ecma262/#sec-stringtonumber
export function stringToNumber(str: string) {
	// Simplified implementation by using implementation conversion.
	return EngineValue.number(Number(str));
}

// https://tc39.es/ecma262/#sec-tointegerorinfinity
export function toIntegerOrInfinity(argument: EngineValue): CompletionRecord<number> {
	const numberValue = toNumber(argument);
	if (numberValue.type === "throw") {
		return numberValue;
	}

	const value = numberValue.value.data.value;

	if (isNaN(value) || EngineValueUtils.isPositiveOrNegativeZero(value)) {
		return normalCompletion(0);
	}

	if (value === Infinity || value === -Infinity) {
		return normalCompletion(value);
	}

	return value < 0 ?
			normalCompletion(-Math.floor(-value))
		:	normalCompletion(Math.floor(value));
}

// https://tc39.es/ecma262/#sec-toint32
export function toInt32(argument: EngineValue): CompletionRecord<EngineValue<"number">> {
	const numberValue = toNumber(argument);
	if (numberValue.type === "throw") {
		return numberValue;
	}

	const number = numberValue.value.data.value;

	if (!isFinite(number) || EngineValueUtils.isPositiveOrNegativeZero(number)) {
		return normalCompletion(EngineValue.number(0));
	}

	const int = number < 0 ? -Math.floor(-number) : Math.floor(number);
	const int32bit = int % 2 ** 32;

	if (int32bit >= 2 ** 31) {
		return normalCompletion(EngineValue.number(int32bit - 2 ** 32));
	}

	return normalCompletion(EngineValue.number(int32bit));
}

// https://tc39.es/ecma262/#sec-touint32
export function toUint32(argument: EngineValue): CompletionRecord<EngineValue<"number">> {
	const numberValue = toNumber(argument);
	if (numberValue.type === "throw") {
		return numberValue;
	}

	const number = numberValue.value.data.value;

	if (!isFinite(number) || EngineValueUtils.isPositiveOrNegativeZero(number)) {
		return normalCompletion(EngineValue.number(0));
	}

	const int = number < 0 ? -Math.floor(-number) : Math.floor(number);
	const int32bit = int >>> 0;

	return normalCompletion(EngineValue.number(int32bit));
}

// https://tc39.es/ecma262/#sec-toint16
export function toInt16(argument: EngineValue): CompletionRecord<EngineValue<"number">> {
	const numberValue = toNumber(argument);
	if (numberValue.type === "throw") {
		return numberValue;
	}

	const number = numberValue.value.data.value;

	if (!isFinite(number) || EngineValueUtils.isPositiveOrNegativeZero(number)) {
		return normalCompletion(EngineValue.number(0));
	}

	const int = number < 0 ? -Math.floor(-number) : Math.floor(number);
	const int16bit = int % 2 ** 16;

	if (int16bit >= 2 ** 15) {
		return normalCompletion(EngineValue.number(int16bit - 2 ** 16));
	}

	return normalCompletion(EngineValue.number(int16bit));
}

// https://tc39.es/ecma262/#sec-touint16
export function toUint16(argument: EngineValue): CompletionRecord<EngineValue<"number">> {
	const numberValue = toNumber(argument);
	if (numberValue.type === "throw") {
		return numberValue;
	}
	const number = numberValue.value.data.value;

	if (!isFinite(number) || EngineValueUtils.isPositiveOrNegativeZero(number)) {
		return normalCompletion(EngineValue.number(0));
	}
	const int = number < 0 ? -Math.floor(-number) : Math.floor(number);
	const int16bit = int & 0xffff;
	return normalCompletion(EngineValue.number(int16bit));
}

// https://tc39.es/ecma262/#sec-toint8
export function toInt8(argument: EngineValue): CompletionRecord<EngineValue<"number">> {
	const numberValue = toNumber(argument);
	if (numberValue.type === "throw") {
		return numberValue;
	}

	const number = numberValue.value.data.value;

	if (!isFinite(number) || EngineValueUtils.isPositiveOrNegativeZero(number)) {
		return normalCompletion(EngineValue.number(0));
	}

	const int = number < 0 ? -Math.floor(-number) : Math.floor(number);
	const int8bit = int % 2 ** 8;

	if (int8bit >= 2 ** 7) {
		return normalCompletion(EngineValue.number(int8bit - 2 ** 8));
	}

	return normalCompletion(EngineValue.number(int8bit));
}

// https://tc39.es/ecma262/#sec-touint8
export function toUint8(argument: EngineValue): CompletionRecord<EngineValue<"number">> {
	const numberValue = toNumber(argument);
	if (numberValue.type === "throw") {
		return numberValue;
	}
	const number = numberValue.value.data.value;

	if (!isFinite(number) || EngineValueUtils.isPositiveOrNegativeZero(number)) {
		return normalCompletion(EngineValue.number(0));
	}
	const int = number < 0 ? -Math.floor(-number) : Math.floor(number);
	const int8bit = int & 0xff;
	return normalCompletion(EngineValue.number(int8bit));
}

// https://tc39.es/ecma262/#sec-touint8clamp
export function toUint8Clamp(
	argument: EngineValue,
): CompletionRecord<EngineValue<"number">> {
	const numberValue = toNumber(argument);
	if (numberValue.type === "throw") {
		return numberValue;
	}
	const number = numberValue.value.data.value;

	if (isNaN(number)) {
		return normalCompletion(EngineValue.number(0));
	}

	const clamped =
		number < 0 ? 0
		: number > 255 ? 255
		: number;
	const floored = Math.floor(clamped);
	if (floored < clamped + 0.5) {
		return normalCompletion(EngineValue.number(floored));
	} else if (floored > clamped + 0.5) {
		return normalCompletion(EngineValue.number(floored + 1));
	}

	// Round to even rule
	if (floored % 2 === 0) {
		return normalCompletion(EngineValue.number(floored));
	}
	return normalCompletion(EngineValue.number(floored + 1));
}

// https://tc39.es/ecma262/#sec-tobigint
export function toBigint(argument: EngineValue) {
	const prim = toPrimitive(argument, "number");
	if (prim.type === "throw") {
		return prim;
	}

	const value = prim.value;

	if (value.isUndefined()) {
		return throwCompletion(new TypeError("Cannot convert undefined to a BigInt"));
	} else if (value.isNull()) {
		return throwCompletion(new TypeError("Cannot convert null to a BigInt"));
	} else if (value.isBoolean()) {
		return normalCompletion(EngineValue.bigint(value.data.value ? 1n : 0n));
	} else if (value.isNumber()) {
		return throwCompletion(new TypeError("Cannot convert a number to a BigInt"));
	} else if (value.isString()) {
		const n = StringToBigInt(value.data.value);
		if (n.isUndefined()) {
			return throwCompletion(new SyntaxError("Can't convert string to BigInt"));
		}
		return normalCompletion(n.asBigInt());
	} else if (value.isSymbol()) {
		return throwCompletion(new TypeError("Cannot convert a Symbol value to a BigInt"));
	}

	throw new Error("Should never reach here.");
}

// https://tc39.es/ecma262/#sec-stringtobigint
export function StringToBigInt(str: string) {
	// Wee shortcut here
	try {
		return EngineValue.bigint(BigInt(str));
	} catch {
		return EngineValue.undefined();
	}
}

// https://tc39.es/ecma262/#sec-tobigint64
export function toBigInt64(argument: EngineValue) {
	const n = toBigint(argument);
	if (n.type === "throw") {
		return n;
	}

	const int64bit = n.value.data.value & 0xffffffffffffffffn;
	return normalCompletion(EngineValue.bigint(int64bit));
}

// https://tc39.es/ecma262/#sec-tostring
export function toString(argument: EngineValue): CompletionRecord<EngineValue<"string">> {
	if (argument.isString()) {
		return normalCompletion(argument);
	}

	if (argument.isSymbol()) {
		return throwCompletion(new TypeError("Cannot convert a Symbol value to a string"));
	}

	if (argument.isUndefined()) {
		return normalCompletion(EngineValue.string("undefined"));
	}

	if (argument.isNull()) {
		return normalCompletion(EngineValue.string("null"));
	}

	if (argument.isBoolean()) {
		return normalCompletion(EngineValue.string(argument.data.value ? "true" : "false"));
	}

	if (argument.isNumber()) {
		return normalCompletion(argument.numberToString(10));
	}

	if (argument.isBigInt()) {
		return normalCompletion(argument.bigintToString(10));
	}

	const primValue = toPrimitive(argument, "string");
	if (primValue.type === "throw") {
		return primValue;
	}

	return toString(primValue.value);
}

// https://tc39.es/ecma262/#sec-toobject
export function toObject(
	_argument: EngineValue,
): CompletionRecord<EngineValue<"object">> {
	throw new Error("Not implemented. Requires intrinsics for Boolean, Number, etc.");
}

// https://tc39.es/ecma262/#sec-topropertykey
export function toPropertyKey(argument: EngineValue): CompletionRecord<PropertyKey> {
	const key = toPrimitive(argument, "string");
	if (key.type === "throw") {
		return key;
	}

	const value = key.value;
	if (value.isSymbol()) {
		return normalCompletion(value);
	}

	const str = toString(value);
	if (str.type === "throw") {
		return str;
	}

	return normalCompletion(str.value?.data.value);
}

// https://tc39.es/ecma262/#sec-tolength
export function toLength(argument: EngineValue): CompletionRecord<number> {
	const len = toIntegerOrInfinity(argument);
	if (len.type === "throw") {
		return len;
	}

	const value = len.value;
	if (value <= 0) {
		return normalCompletion(0);
	}

	return normalCompletion(Math.min(value, 2 ** 53 - 1));
}

// https://tc39.es/ecma262/#sec-canonicalnumericindexstring
export function canonicalNumericIndexString(
	argument: EngineValue<"string">,
): EngineValue<"number" | "undefined"> {
	if (argument.data.value === "-0") {
		return EngineValue.number(-0);
	}

	const n = toNumber(argument);
	if (n.type === "throw") {
		throw n.error;
	}

	const stringifiedArg = toString(n.value);
	if (stringifiedArg.type === "throw") {
		throw stringifiedArg.error;
	}

	if (stringifiedArg.value.data.value === argument.data.value) {
		return n.value;
	}

	return EngineValue.undefined();
}

// https://tc39.es/ecma262/#sec-toindex
export function toIndex(argument: EngineValue): CompletionRecord<number> {
	const n = toIntegerOrInfinity(argument);
	if (n.type === "throw") {
		return n;
	}

	const value = n.value;

	if (value < 0 || value > 2 ** 53 - 1) {
		return throwCompletion(new RangeError("Index out of range"));
	}

	return normalCompletion(value);
}
