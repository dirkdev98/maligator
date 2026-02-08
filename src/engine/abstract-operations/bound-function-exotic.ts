import { normalCompletion } from "../types-and-values/completion-record.ts";
import type { EngineValue, ObjectInternalSlots } from "../types-and-values/data-types.ts";
import { call, construct, makeBasicObject } from "./object-operations.ts";
import { isConstructor, sameValue } from "./testing-and-comparison.ts";

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#bound-function-exotic-object
export const BoundFunctionExoticMethods = {
	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-bound-function-exotic-objects-call-thisargument-argumentslist
	Call: (
		F: EngineValue<"object">,
		_thisArgument: EngineValue,
		argumentsList: Array<EngineValue>,
	) => {
		const target = F.objectGetInternalSlot("BoundTargetFunction");
		const boundThis = F.objectGetInternalSlot("BoundThis");
		const boundArguments = F.objectGetInternalSlot("BoundArguments");

		const args = [...boundArguments, ...argumentsList];

		return call(target, boundThis, args);
	},

	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-bound-function-exotic-objects-construct-argumentslist-newtarget
	Construct: (
		F: EngineValue<"object">,
		argumentsList: Array<EngineValue>,
		newTarget: EngineValue<"object">,
	) => {
		const target = F.objectGetInternalSlot("BoundTargetFunction");
		const boundArguments = F.objectGetInternalSlot("BoundArguments");

		const args = [...boundArguments, ...argumentsList];

		if (sameValue(F, newTarget)) {
			newTarget = target;
		}
		return construct(target, args, newTarget);
	},
} satisfies Partial<ObjectInternalSlots>;

export function isBoundFunctionExotic(obj: EngineValue<"object">): boolean {
	return (
		obj.objectGetInternalSlot("Call") === BoundFunctionExoticMethods.Call &&
		obj.objectGetInternalSlot("Construct") === BoundFunctionExoticMethods.Construct
	);
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-boundfunctioncreate
export function boundFunctionCreate(
	targetFunction: EngineValue<"object">,
	boundThis: EngineValue,
	boundArgs: Array<EngineValue>,
) {
	const proto = targetFunction.objectGetInternalSlot("GetPrototypeOf")(targetFunction);
	if (proto.type === "throw") {
		return proto;
	}
	const internalSlotList = [
		"Prototype",
		"Extensible",
		"BoundTargetFunction",
		"BoundThis",
		"BoundArguments",
	];
	const obj = makeBasicObject(internalSlotList);
	obj.objectSetInternalSlot("Prototype", proto.value);

	obj.objectSetInternalSlot("Call", BoundFunctionExoticMethods.Call);
	if (isConstructor(targetFunction).data.value) {
		obj.objectSetInternalSlot("Construct", BoundFunctionExoticMethods.Construct);
	}

	obj.objectSetInternalSlot("BoundTargetFunction", targetFunction);
	obj.objectSetInternalSlot("BoundThis", boundThis);
	obj.objectSetInternalSlot("BoundArguments", boundArgs);

	return normalCompletion(obj);
}
