import type { EngineValue } from "../data-types.ts";
import type { PropertyDescriptor } from "./property-map.ts";
import type { PropertyKey } from "./property-map.ts";

export const ArrayExoticMethods = {
	DefineOwnProperty: (
		_obj: EngineValue<"object">,
		_P: PropertyKey,
		_Desc: PropertyDescriptor,
	) => {
		// TODO:
	},
};

// TODO: ArrayExoticMethods.DefineOwnProperty should return CompletionRecord<EngineValue<"boolean">>
// See ECMAScript specification for Array exotic objects DefineOwnProperty internal method
// https://tc39.es/ecma262/#sec-array-exotic-objects-defineownproperty-p-desc

export function isArrayExoticObject(obj: EngineValue<"object">): boolean {
	return (
		obj.objectGetInternalSlot("DefineOwnProperty") ===
		ArrayExoticMethods.DefineOwnProperty
	);
}
