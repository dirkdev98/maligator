import type { EngineValue } from "../types-and-values/data-types.ts";

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#bound-function-exotic-object
export const BoundFunctionExoticMethods = {
	Call: (
		_F: EngineValue<"object">,
		_thisArgument: EngineValue<"object">,
		_argumentsList: Array<EngineValue>,
	) => {
		// TODO:
	},

	Construct: (
		_F: EngineValue<"object">,
		_argumentsList: Array<EngineValue>,
		_newTarget: EngineValue<"object">,
	) => {
		// TODO:
	},
};

export function isBoundFunctionExotic(obj: EngineValue<"object">): boolean {
	return (
		obj.objectGetInternalSlot("Call") === BoundFunctionExoticMethods.Call &&
		obj.objectGetInternalSlot("Construct") === BoundFunctionExoticMethods.Construct
	);
}
