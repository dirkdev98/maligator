import { EngineValueUtils, EngineValue } from "../data-types.ts";
import { normalCompletion, throwCompletion } from "../specification-types.ts";
import type { CompletionRecord } from "../specification-types.ts";

// https://tc39.es/ecma262/#sec-toprimitive
export function toPrimitive(
	_input: EngineValue,
	_hint?: "default" | "string" | "number",
): CompletionRecord<EngineValue> {
	throw new Error("Not implemented");
}

// https://tc39.es/ecma262/#sec-ordinarytoprimitive
export function ordinaryToPrimitive(
	_input: EngineValue,
	_hint: "string" | "number",
): CompletionRecord<EngineValue> {
	throw new Error("Not implemented");
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
