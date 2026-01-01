// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots
import { isNil } from "../../utils.ts";
import { EngineValue } from "../data-types.ts";
import type { ObjectInternalSlots } from "../data-types.ts";
import { normalCompletion } from "./completion-record.ts";
import type { CompletionRecord } from "./completion-record.ts";
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
		return normalCompletion(OrdinaryGetOwnProperty(obj, P));
	},

	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-defineownproperty-p-desc
	DefineOwnProperty: (
		obj: EngineValue<"object">,
		P: PropertyKey,
		Desc: PropertyDescriptor,
	) => {
		return OrdinaryDefineOwnProperty(obj, P, Desc);
	},

	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-hasproperty-p
	HasProperty: (
		obj: EngineValue<"object">,
		P: PropertyKey,
	): CompletionRecord<EngineValue<"boolean">> => {
		return OrdinaryHasProperty(obj, P);
	},
} satisfies Partial<ObjectInternalSlots>;

// https://tc39.es/ecma262/#sec-ordinarygetownproperty
export function OrdinaryGetOwnProperty(obj: EngineValue<"object">, P: PropertyKey) {
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
export function OrdinaryDefineOwnProperty(
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
		ValidateAndApplyPropertyDescriptor(
			obj,
			P,
			extensible.value.data.value,
			Desc,
			current.value,
		),
	);
}

// https://tc39.es/ecma262/#sec-iscompatiblepropertydescriptor
export function IsCompatiblePropertyDescriptor(
	extensible: boolean,
	Desc: PropertyDescriptor,
	Current: PropertyDescriptor | EngineValue<"undefined">,
) {
	return ValidateAndApplyPropertyDescriptor(
		EngineValue.undefined(),
		"",
		extensible,
		Desc,
		Current,
	);
}

// https://tc39.es/ecma262/#sec-validateandapplypropertydescriptor
export function ValidateAndApplyPropertyDescriptor(
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
export function OrdinaryHasProperty(obj: EngineValue<"object">, P: PropertyKey) {
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
