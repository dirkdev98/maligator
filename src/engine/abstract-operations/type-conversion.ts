import { EngineValueUtils, EngineValue } from "../data-types.ts";
import { normalCompletion, throwCompletion } from "../specification-types.ts";
import type { CompletionRecord } from "../specification-types.ts";

// https://tc39.es/ecma262/#sec-tonumber
export function toNumber(argument: EngineValue): CompletionRecord<EngineValue<"number">> {
	if (argument.isNumber()) {
		return normalCompletion(argument);
	}

	if (argument.isSymbol() || argument.isBigInt()) {
		// TODO: Error handling
		return throwCompletion(new TypeError("Cannot convert a Symbol value to a number"));
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

	// TODO: spec compliant
	// 7. Assert: argument is an Object.
	// 8. Let primValue be ? ToPrimitive(argument, number).
	//                  9. Assert: primValue is not an Object.
	// 10. Return ? ToNumber(primValue).

	throw new Error("Spec not implemented");
}

// https://tc39.es/ecma262/#sec-stringtonumber
export function stringToNumber(str: string) {
	// Simplified implementation by using implementation conversion.
	return EngineValue.number(Number(str));
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
		return normalCompletion(EngineValue.number(int32bit - (2 ^ 32)));
	}

	return normalCompletion(EngineValue.number(int32bit));
}
