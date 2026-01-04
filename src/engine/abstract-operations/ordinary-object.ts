// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots
import { isNil } from "../../utils.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import type { ObjectInternalSlots } from "../types-and-values/data-types.ts";
import { createDataProperty, makeBasicObject } from "./object-operations.ts";
import { PropertyDescriptor } from "./property-map.ts";
import type { PropertyKey } from "./property-map.ts";
import { sameValue, sameValueWrapped } from "./testing-and-comparison.ts";

export const OrdinaryObjectInternalMethods = {
	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-getprototypeof
	GetPrototypeOf: (obj: EngineValue<"object">) => {
		return normalCompletion(obj.objectGetInternalSlot("Prototype"));
	},

	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-setprototypeof-v
	SetPrototypeOf: (obj: EngineValue<"object">, V: EngineValue<"object" | "null">) => {
		const current = obj.objectGetInternalSlot("Prototype");

		if (sameValue(current, V)) {
			return normalCompletion(EngineValue.boolean(true));
		}

		const extensible = obj.objectGetInternalSlot("Extensible");
		if (!extensible) {
			return normalCompletion(EngineValue.boolean(false));
		}

		let p = V;
		let done = false;
		while (!done) {
			if (p.isNull()) {
				done = true;
			} else if (sameValue(p, obj)) {
				return normalCompletion(EngineValue.boolean(false));
			} else {
				if (
					!p.isObject() ||
					p.objectGetInternalSlot("GetPrototypeOf") !==
						OrdinaryObjectInternalMethods.GetPrototypeOf
				) {
					done = true;
				} else {
					p = p.objectGetInternalSlot("Prototype");
				}
			}
		}

		obj.objectSetInternalSlot("Prototype", V);
		return normalCompletion(EngineValue.boolean(true));
	},

	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-isextensible
	IsExtensible: (obj: EngineValue<"object">) => {
		return normalCompletion(EngineValue.boolean(obj.objectGetInternalSlot("Extensible")));
	},

	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-setprototypeof-v
	PreventExtensions: (obj: EngineValue<"object">) => {
		obj.objectSetInternalSlot("Extensible", false);
		return normalCompletion(EngineValue.boolean(true));
	},

	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-getownproperty-p
	GetOwnProperty: (obj: EngineValue<"object">, P: PropertyKey) => {
		return normalCompletion(ordinaryGetOwnProperty(obj, P));
	},

	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-defineownproperty-p-desc
	DefineOwnProperty: (
		obj: EngineValue<"object">,
		P: PropertyKey,
		Desc: PropertyDescriptor,
	) => {
		return ordinaryDefineOwnProperty(obj, P, Desc);
	},

	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-hasproperty-p
	HasProperty: (
		obj: EngineValue<"object">,
		P: PropertyKey,
	): CompletionRecord<EngineValue<"boolean">> => {
		return ordinaryHasProperty(obj, P);
	},

	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinary-object-internal-methods-and-internal-slots-get-p-receiver
	Get(
		obj: EngineValue<"object">,
		P: PropertyKey,
		receiver: EngineValue,
	): CompletionRecord<EngineValue> {
		return ordinaryGet(obj, P, receiver);
	},

	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinary-object-internal-methods-and-internal-slots-set-p-v-receiver
	Set(
		obj: EngineValue<"object">,
		P: PropertyKey,
		V: EngineValue,
		receiver: EngineValue,
	): CompletionRecord<EngineValue<"boolean">> {
		return ordinarySet(obj, P, V, receiver);
	},

	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinary-object-internal-methods-and-internal-slots-delete-p
	Delete(
		obj: EngineValue<"object">,
		P: PropertyKey,
	): CompletionRecord<EngineValue<"boolean">> {
		return ordinaryDelete(obj, P);
	},
} satisfies Partial<ObjectInternalSlots>;

// https://tc39.es/ecma262/#sec-ordinarygetownproperty
export function ordinaryGetOwnProperty(obj: EngineValue<"object">, P: PropertyKey) {
	if (!obj.data.properties.has(P)) {
		return EngineValue.undefined();
	}

	const D = new PropertyDescriptor();
	const X = obj.data.properties.get(P);

	if (X.isDataDescriptor()) {
		D.value = X.value;
		D.writable = X.writable;
	} else {
		D.get = X.get;
		D.set = X.set;
	}

	D.enumerable = X.enumerable;
	D.configurable = X.configurable;

	return D;
}

// https://tc39.es/ecma262/#sec-ordinarydefineownproperty
export function ordinaryDefineOwnProperty(
	obj: EngineValue<"object">,
	P: PropertyKey,
	Desc: PropertyDescriptor,
) {
	const current = obj.objectGetInternalSlot("GetOwnProperty")(obj, P);
	if (current.type === "throw") {
		return current;
	}

	const extensible = obj.objectGetInternalSlot("IsExtensible")(obj);
	if (extensible.type === "throw") {
		return extensible;
	}

	return normalCompletion(
		validateAndApplyPropertyDescriptor(
			obj,
			P,
			extensible.value.data.value,
			Desc,
			current.value,
		),
	);
}

// https://tc39.es/ecma262/#sec-iscompatiblepropertydescriptor
export function isCompatiblePropertyDescriptor(
	extensible: boolean,
	Desc: PropertyDescriptor,
	Current: PropertyDescriptor | EngineValue<"undefined">,
) {
	return validateAndApplyPropertyDescriptor(
		EngineValue.undefined(),
		"",
		extensible,
		Desc,
		Current,
	);
}

// https://tc39.es/ecma262/#sec-validateandapplypropertydescriptor
export function validateAndApplyPropertyDescriptor(
	O: EngineValue<"object" | "undefined">,
	P: PropertyKey,
	extensible: boolean,
	Desc: PropertyDescriptor,
	current: PropertyDescriptor | EngineValue<"undefined">,
) {
	if (current instanceof EngineValue && current.isUndefined()) {
		if (!extensible) {
			return EngineValue.boolean(false);
		}

		if (O.isUndefined()) {
			return EngineValue.boolean(true);
		}

		if (Desc.isAccessorDescriptor()) {
			const copy = Desc.copyAccessor();
			copy.setGetDefaultIfNotSet();
			copy.setSetDefaultIfNotSet();
			copy.setEnumerableDefaultIfNotSet();
			copy.setConfigurableDefaultIfNotSet();

			O.asObject().data.properties.set(P, copy);
		} else {
			const copy = Desc.copyDescriptor();
			copy.setValueDefaultIfNotSet();
			copy.setWritableDefaultIfNotSet();
			copy.setEnumerableDefaultIfNotSet();
			copy.setConfigurableDefaultIfNotSet();

			O.asObject().data.properties.set(P, copy);
		}

		return EngineValue.boolean(true);
	}

	if (!Desc.hasFields()) {
		return EngineValue.boolean(true);
	}

	if (current.configurable === false) {
		if (Desc.configurable) {
			return EngineValue.boolean(false);
		}

		if (!isNil(Desc.enumerable) && Desc.enumerable !== current.enumerable) {
			return EngineValue.boolean(false);
		}

		if (
			!Desc.isGenericDescriptor() &&
			Desc.isAccessorDescriptor() !== current.isAccessorDescriptor()
		) {
			return EngineValue.boolean(false);
		}

		if (current.isAccessorDescriptor()) {
			if (!isNil(Desc.get) && !isNil(current.get) && !sameValue(Desc.get, current.get)) {
				return EngineValue.boolean(false);
			}

			if (!isNil(Desc.set) && !isNil(current.set) && !sameValue(Desc.set, current.set)) {
				return EngineValue.boolean(false);
			}
		}

		if (current.writable === false) {
			if (Desc.writable === true) {
				return EngineValue.boolean(false);
			}

			if (!isNil(Desc.value)) {
				return sameValueWrapped(Desc.value, current.value!);
			}
		}
	}

	if (!O.isUndefined()) {
		if (current.isDataDescriptor() && Desc.isAccessorDescriptor()) {
			const copy = Desc.copyAccessor();
			copy.configurable ??= current.configurable;
			copy.enumerable ??= current.enumerable;
			copy.setGetDefaultIfNotSet();
			copy.setSetDefaultIfNotSet();

			O.asObject().data.properties.set(P, copy);
		} else if (current.isAccessorDescriptor() && Desc.isDataDescriptor()) {
			const copy = Desc.copyDescriptor();
			copy.configurable ??= current.configurable;
			copy.enumerable ??= current.enumerable;
			copy.setValueDefaultIfNotSet();
			copy.setWritableDefaultIfNotSet();

			O.asObject().data.properties.set(P, copy);
		} else {
			current.value = Desc.value;
			current.writable = Desc.writable;
			current.get = Desc.get;
			current.set = Desc.set;
			current.enumerable = Desc.enumerable;
			current.configurable = Desc.configurable;
		}
	}

	return EngineValue.boolean(true);
}

// https://tc39.es/ecma262/#sec-ordinaryhasproperty
export function ordinaryHasProperty(obj: EngineValue<"object">, P: PropertyKey) {
	const hasOwn = obj.objectGetInternalSlot("GetOwnProperty")(obj, P);
	if (hasOwn.type === "throw") {
		return hasOwn;
	}

	if (hasOwn.value instanceof PropertyDescriptor) {
		return normalCompletion(EngineValue.boolean(true));
	}

	const parent = obj.objectGetInternalSlot("GetPrototypeOf")(obj);
	if (parent.type === "throw") {
		return parent;
	}

	if (parent.value.isObject()) {
		return parent.value.objectGetInternalSlot("HasProperty")(parent.value, P);
	}

	return normalCompletion(EngineValue.boolean(false));
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinaryget
export function ordinaryGet(
	obj: EngineValue<"object">,
	P: PropertyKey,
	receiver: EngineValue,
): CompletionRecord<EngineValue> {
	const desc = obj.objectGetInternalSlot("GetOwnProperty")(obj, P);
	if (desc.type === "throw") {
		return desc;
	}

	if (desc.value instanceof EngineValue && desc.value.isUndefined()) {
		const parent = obj.objectGetInternalSlot("GetPrototypeOf")(obj);
		if (parent.type === "throw") {
			return parent;
		}

		if (parent.value.isNull()) {
			return normalCompletion(EngineValue.undefined());
		}

		return parent.value.asObject().objectGetInternalSlot("Get")(
			parent.value.asObject(),
			P,
			receiver,
		);
	}

	if (desc.value.isDataDescriptor() && desc.value.value) {
		return normalCompletion(desc.value.value);
	}

	const getter = desc.value.get!;
	if (getter.isUndefined()) {
		return normalCompletion(EngineValue.undefined());
	}

	// TODO: Return ? Call(getter, Receiver).
	throw new Error("Not implemented. Requires 'Call'.");
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinaryset
export function ordinarySet(
	obj: EngineValue<"object">,
	P: PropertyKey,
	V: EngineValue,
	receiver: EngineValue,
): CompletionRecord<EngineValue<"boolean">> {
	const ownDesc = obj.objectGetInternalSlot("GetOwnProperty")(obj, P);
	if (ownDesc.type === "throw") {
		return ownDesc;
	}

	return ordinarySetWithOwnDescriptor(obj, P, V, receiver, ownDesc.value);
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinarysetwithowndescriptor
export function ordinarySetWithOwnDescriptor(
	obj: EngineValue<"object">,
	P: PropertyKey,
	V: EngineValue,
	receiver: EngineValue,
	ownDesc: PropertyDescriptor | EngineValue<"undefined">,
): CompletionRecord<EngineValue<"boolean">> {
	if (ownDesc instanceof EngineValue && ownDesc.isUndefined()) {
		const parent = obj.objectGetInternalSlot("GetPrototypeOf")(obj);
		if (parent.type === "throw") {
			return parent;
		}

		if (!parent.value.isNull()) {
			return parent.value.asObject().objectGetInternalSlot("Set")(
				parent.value.asObject(),
				P,
				V,
				receiver,
			);
		}

		ownDesc = new PropertyDescriptor({
			value: EngineValue.undefined(),
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}

	if (ownDesc.isDataDescriptor()) {
		if (!ownDesc.writable) {
			return normalCompletion(EngineValue.boolean(false));
		}

		if (!receiver.isObject()) {
			return normalCompletion(EngineValue.boolean(false));
		}

		const existingDescriptor = receiver.objectGetInternalSlot("GetOwnProperty")(
			receiver,
			P,
		);
		if (existingDescriptor.type === "throw") {
			return existingDescriptor;
		}

		if (existingDescriptor.value instanceof PropertyDescriptor) {
			if (existingDescriptor.value.isAccessorDescriptor()) {
				return normalCompletion(EngineValue.boolean(false));
			}

			if (existingDescriptor.value.writable === false) {
				return normalCompletion(EngineValue.boolean(false));
			}

			const valueDesc = new PropertyDescriptor({
				value: V,
			});
			return receiver.objectGetInternalSlot("DefineOwnProperty")(receiver, P, valueDesc);
		}

		return createDataProperty(receiver, P, V);
	}

	const setter = ownDesc.set!;
	if (setter.isUndefined()) {
		return normalCompletion(EngineValue.boolean(false));
	}

	// 6. Perform ? Call(setter, Receiver, « V »).
	throw new Error("Not implemented. Requires 'Call'.");

	// return normalCompletion(EngineValue.boolean(true));
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinarydelete
export function ordinaryDelete(obj: EngineValue<"object">, P: PropertyKey) {
	const desc = obj.objectGetInternalSlot("GetOwnProperty")(obj, P);
	if (desc.type === "throw") {
		return desc;
	}

	if (desc.value instanceof EngineValue && desc.value.isUndefined()) {
		return normalCompletion(EngineValue.boolean(true));
	}

	if (desc.value.configurable === true) {
		obj.data.properties.delete(P);
		return normalCompletion(EngineValue.boolean(true));
	}

	return normalCompletion(EngineValue.boolean(false));
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinaryobjectcreate
export function ordinaryObjectCreate(
	proto: EngineValue<"object" | "null">,
	additionalInternalSlots: Array<string> = [],
) {
	const internalSlots = ["Prototype", "Extensible", ...additionalInternalSlots];
	const O = makeBasicObject(internalSlots);
	O.objectSetInternalSlot("Prototype", proto);

	return O;
}
