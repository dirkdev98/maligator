import { EngineValue } from "../data-types.ts";
import { isArrayExoticObject } from "./array-exotic.ts";
import { normalCompletion, throwCompletion } from "./completion-record.ts";
import type { CompletionRecord } from "./completion-record.ts";

export const UNUSED = -1;

// https://tc39.es/ecma262/#sec-requireobjectcoercible
export function requireObjectCoercible(
	argument: EngineValue,
): CompletionRecord<typeof UNUSED> {
	if (argument.isUndefined() || argument.isNull()) {
		return throwCompletion(new TypeError(`Argument can't be converted to an object.`));
	}

	return normalCompletion(UNUSED);
}

// https://tc39.es/ecma262/#sec-isarray
export function isArray(value: EngineValue): CompletionRecord<EngineValue<"boolean">> {
	if (!value.isObject()) {
		return normalCompletion(EngineValue.boolean(false));
	}

	if (isArrayExoticObject(value)) {
		return normalCompletion(EngineValue.boolean(true));
	}

	throw new Error("Not implemented. Needs Proxy object detection.");

	return normalCompletion(EngineValue.boolean(false));
}

// https://tc39.es/ecma262/#sec-iscallable
export function isCallable(argument: EngineValue) {
	if (!argument.isObject()) {
		return EngineValue.boolean(false);
	}

	return EngineValue.boolean(argument.objectHasInternalSlot("Call"));
}

// https://tc39.es/ecma262/#sec-isconstructor
export function isConstructor(argument: EngineValue) {
	if (!argument.isObject()) {
		return EngineValue.boolean(false);
	}

	return EngineValue.boolean(argument.objectHasInternalSlot("Construct"));
}

// https://tc39.es/ecma262/#sec-isextensible-o
export function isExtensible(O: EngineValue<"object">) {
	return O.objectGetInternalSlot("IsExtensible")(O);
}

// https://tc39.es/ecma262/#sec-isregexp
export function isRegExp(
	_argument: EngineValue,
): CompletionRecord<EngineValue<"boolean">> {
	throw new Error("Not implemented. Needs Get support");
}
