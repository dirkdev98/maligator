import { getCurrentRealm } from "../execution-contexts/execution-context.ts";
import {
	normalCompletion,
	throwCompletion,
} from "../types-and-values/completion-record.ts";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import type { ObjectInternalSlots } from "../types-and-values/data-types.ts";
import { isBoundFunctionExotic } from "./bound-function-exotic.ts";
import { OrdinaryObjectInternalMethods } from "./ordinary-object.ts";
import { PropertyDescriptor } from "./property-map.ts";
import type { PropertyKey } from "./property-map.ts";
import { isCallable, sameValue } from "./testing-and-comparison.ts";
import { toObject } from "./type-conversion.ts";

const UNUSED = -1;

// https://tc39.es/ecma262/#sec-makebasicobject
export function makeBasicObject(internalSlotsList: Array<string>): EngineValue<"object"> {
	internalSlotsList = [...internalSlotsList, "PrivateElements"];
	const obj = EngineValue.object(internalSlotsList);
	obj.objectSetInternalSlot("PrivateElements", []);

	for (const [key, value] of Object.entries(OrdinaryObjectInternalMethods)) {
		obj.objectSetInternalSlot(key as keyof ObjectInternalSlots, value);
	}

	if (internalSlotsList.includes("Extensible")) {
		obj.objectSetInternalSlot("Extensible", true);
	}

	return obj;
}

// https://tc39.es/ecma262/#sec-get-o-p
export function get(
	O: EngineValue<"object">,
	P: PropertyKey,
): CompletionRecord<EngineValue> {
	return O.objectGetInternalSlot("Get")(O, P, O);
}

// https://tc39.es/ecma262/#sec-getv
export function getV(V: EngineValue, P: PropertyKey): CompletionRecord<EngineValue> {
	const O = toObject(V);
	if (O.type === "throw") {
		return O;
	}

	return O.value.objectGetInternalSlot("Get")(O.value, P, O.value);
}

// https://tc39.es/ecma262/#sec-set-o-p-v-throw
export function set(
	O: EngineValue<"object">,
	P: PropertyKey,
	V: EngineValue,
	Throw: boolean = false,
): CompletionRecord<typeof UNUSED> {
	const success = O.objectGetInternalSlot("Set")(O, P, V, O);
	if (success.type === "throw") {
		return success;
	}

	if (!success.value.data.value && Throw) {
		return throwCompletion(new TypeError("Cannot 'set' property."));
	}

	return normalCompletion(UNUSED);
}

// https://tc39.es/ecma262/#sec-createdataproperty
export function createDataProperty(
	O: EngineValue<"object">,
	P: PropertyKey,
	V: EngineValue,
) {
	const newDesc = new PropertyDescriptor({
		value: V,
		writable: true,
		enumerable: true,
		configurable: true,
	});

	return O.objectGetInternalSlot("DefineOwnProperty")(O, P, newDesc);
}

// https://tc39.es/ecma262/#sec-createdatapropertyorthrow
export function createDataPropertyOrThrow(
	O: EngineValue<"object">,
	P: PropertyKey,
	V: EngineValue,
) {
	const success = createDataProperty(O, P, V);

	if (success.type === "throw") {
		return success;
	}

	if (!success.value.data.value) {
		return throwCompletion(new TypeError("Cannot create data property."));
	}

	return normalCompletion(UNUSED);
}

// https://tc39.es/ecma262/#sec-createnonenumerabledatapropertyorthrow
export function createNonEnumerableDataPropertyOrThrow(
	O: EngineValue<"object">,
	P: PropertyKey,
	V: EngineValue,
) {
	const desc = new PropertyDescriptor({
		value: V,
		writable: true,
		enumerable: false,
		configurable: true,
	});

	const result = definePropertyOrThrow(O, P, desc);
	if (result.type === "throw") {
		throw result.error;
	}

	return UNUSED;
}

// https://tc39.es/ecma262/#sec-definepropertyorthrow
export function definePropertyOrThrow(
	O: EngineValue<"object">,
	P: PropertyKey,
	Desc: PropertyDescriptor,
): CompletionRecord<typeof UNUSED> {
	const success = O.objectGetInternalSlot("DefineOwnProperty")(O, P, Desc);
	if (success.type === "throw") {
		return success;
	}

	if (!success.value.data.value) {
		return throwCompletion(new TypeError("Can't define property."));
	}

	return normalCompletion(UNUSED);
}

// https://tc39.es/ecma262/#sec-deletepropertyorthrow
export function deletePropertyOrThrow(O: EngineValue<"object">, P: PropertyKey) {
	const success = O.objectGetInternalSlot("Delete")(O, P);
	if (success.type === "throw") {
		return success;
	}

	if (!success.value.data.value) {
		return throwCompletion(new TypeError("Cannot delete property."));
	}

	return normalCompletion(UNUSED);
}

// https://tc39.es/ecma262/multipage/abstract-operations.html#sec-getmethod
export function getMethod(
	V: EngineValue,
	P: PropertyKey,
): CompletionRecord<EngineValue<"object" | "undefined">> {
	const func = getV(V, P);
	if (func.type === "throw") {
		return func;
	}
	const funcValue = func.value;
	if (funcValue.isNull() || funcValue.isUndefined()) {
		return normalCompletion(EngineValue.undefined());
	}

	const isCallableValue = isCallable(funcValue);
	if (!isCallableValue.data.value) {
		return throwCompletion(new TypeError("Property is not callable."));
	}

	return normalCompletion(funcValue.asObject());
}

// https://tc39.es/ecma262/multipage/abstract-operations.html#sec-hasproperty
export function hasProperty(O: EngineValue<"object">, P: PropertyKey) {
	return O.objectGetInternalSlot("HasProperty")(O, P);
}

// https://tc39.es/ecma262/multipage/abstract-operations.html#sec-hasownproperty
export function hasOwnProperty(O: EngineValue<"object">, P: PropertyKey) {
	const desc = O.objectGetInternalSlot("GetOwnProperty")(O, P);
	if (desc.type === "throw") {
		return desc;
	}

	const descValue = desc.value;

	if (descValue instanceof EngineValue && descValue.isUndefined()) {
		return normalCompletion(EngineValue.boolean(false));
	}

	return normalCompletion(EngineValue.boolean(true));
}

// https://tc39.es/ecma262/multipage/abstract-operations.html#sec-call
export function call(
	F: EngineValue<"object">,
	thisArgument: EngineValue,
	argumentsList?: Array<EngineValue>,
) {
	if (!isCallable(F).data.value) {
		return throwCompletion(new TypeError("Function is not callable."));
	}

	return F.objectGetInternalSlot("Call")(F, thisArgument, argumentsList ?? []);
}

// https://tc39.es/ecma262/multipage/abstract-operations.html#sec-construct
export function construct(
	F: EngineValue<"object">,
	argumentsList?: Array<EngineValue>,
	newTarget?: EngineValue<"object">,
) {
	newTarget ??= F;

	return F.objectGetInternalSlot("Construct")(F, argumentsList ?? [], newTarget);
}

// https://tc39.es/ecma262/multipage/abstract-operations.html#sec-getfunctionrealm
export function getFunctionRealm(F: EngineValue<"object">) {
	if (F.objectHasInternalSlot("Realm")) {
		return F.objectGetInternalSlot("Realm");
	}

	if (isBoundFunctionExotic(F)) {
		// TODO: Bound exotics
		throw new Error("Not implemented.");
	}

	// TODO: Proxy exotics.

	return getCurrentRealm();
}

// https://tc39.es/ecma262/multipage/abstract-operations.html#sec-copydataproperties
export function copyDataProperties(
	target: EngineValue<"object">,
	source: EngineValue,
	excludedItems: Array<PropertyKey>,
): CompletionRecord<unknown> {
	if (source.isUndefined() || source.isNull()) {
		return normalCompletion(undefined);
	}

	const from = toObject(source);
	if (from.type === "throw") {
		return from;
	}

	const keys = from.value.objectGetInternalSlot("OwnPropertyKeys")(from.value.asObject());
	if (keys.type === "throw") {
		return keys;
	}

	for (const key of keys.value) {
		for (const excludedItem of excludedItems) {
			if (typeof key === "string" && key === excludedItem) {
				continue;
			} else if (
				key instanceof EngineValue &&
				excludedItem instanceof EngineValue &&
				sameValue(key, excludedItem)
			) {
				continue;
			}

			const desc = from.value.objectGetInternalSlot("GetOwnProperty")(
				from.value.asObject(),
				key,
			);

			if (desc.type === "throw") {
				return desc;
			}

			if (desc.value instanceof EngineValue || desc.value.enumerable === false) {
				continue;
			}

			const propValue = get(from.value.asObject(), key);
			if (propValue.type === "throw") {
				return propValue;
			}

			createDataPropertyOrThrow(target, key, propValue.value);
		}
	}

	return normalCompletion(undefined);
}
