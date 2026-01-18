import { normalCompletion } from "../types-and-values/completion-record.ts";
import type { EngineValue } from "../types-and-values/data-types.ts";
import { sameValueWrapped } from "./testing-and-comparison.ts";

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-immutable-prototype-exotic-objects-setprototypeof-v
export const ImmutablePrototypeExoticMethods = {
	SetPrototypeOf: (O: EngineValue<"object">, V: EngineValue<"object" | "null">) => {
		return setImmutablePrototype(O, V);
	},
};

export function isImmutablePrototypeExotic(obj: EngineValue<"object">): boolean {
	return (
		obj.objectGetInternalSlot("SetPrototypeOf") ===
		ImmutablePrototypeExoticMethods.SetPrototypeOf
	);
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-set-immutable-prototype
export function setImmutablePrototype(
	obj: EngineValue<"object">,
	value: EngineValue<"object" | "null">,
) {
	const current = obj.objectGetInternalSlot("GetPrototypeOf")(obj);
	if (current.type === "throw") {
		return current;
	}
	return normalCompletion(sameValueWrapped(current.value, value));
}
