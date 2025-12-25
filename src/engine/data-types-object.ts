import { EngineValue } from "./data-types.ts";
import { normalCompletion } from "./specification-types.ts";
import type { CompletionRecord } from "./specification-types.ts";

// TODO: move somewhere else.
function isNil(value: unknown): value is null | undefined {
	return value === null || value === undefined;
}

// https://tc39.es/ecma262/#sec-property-attributes
export class PropertyDescriptor {
	value?: EngineValue;
	writable?: boolean;

	get?: EngineValue<"object" | "undefined">;
	set?: EngineValue<"object" | "undefined">;

	enumerable?: boolean;
	configurable?: boolean;

	constructor(init?: Partial<PropertyDescriptor>) {
		Object.assign(this, init);
	}

	copyAccessor(): PropertyDescriptor {
		return new PropertyDescriptor({
			get: this.get,
			set: this.set,
			enumerable: this.enumerable,
			configurable: this.configurable,
		});
	}

	copyDescriptor(): PropertyDescriptor {
		return new PropertyDescriptor({
			value: this.value,
			writable: this.writable,
			enumerable: this.enumerable,
			configurable: this.configurable,
		});
	}

	hasFields() {
		return (
			!isNil(this.value) ||
			!isNil(this.writable) ||
			!isNil(this.get) ||
			!isNil(this.set) ||
			!isNil(this.enumerable) ||
			!isNil(this.configurable)
		);
	}

	// https://tc39.es/ecma262/#sec-isgenericdescriptor
	isGenericDescriptor() {
		return this.isAccessorDescriptor() || this.isDataDescriptor();
	}

	// https://tc39.es/ecma262/#sec-isaccessordescriptor
	isDataDescriptor() {
		return !isNil(this.value) || !isNil(this.writable);
	}

	// https://tc39.es/ecma262/#sec-isaccessordescriptor
	isAccessorDescriptor() {
		return !isNil(this.get) || !isNil(this.set);
	}

	setValueDefaultIfNotSet() {
		this.value ??= EngineValue.undefined();
	}

	setWritableDefaultIfNotSet() {
		this.writable ??= false;
	}

	setGetDefaultIfNotSet() {
		this.get ??= EngineValue.undefined();
	}

	setSetDefaultIfNotSet() {
		this.set ??= EngineValue.undefined();
	}

	setEnumerableDefaultIfNotSet() {
		this.enumerable ??= false;
	}

	setConfigurableDefaultIfNotSet() {
		this.configurable ??= false;
	}

	// TODO: https://tc39.es/ecma262/#sec-frompropertydescriptor

	// TODO: https://tc39.es/ecma262/#sec-topropertydescriptor

	// TODO: https://tc39.es/ecma262/#sec-completepropertydescriptor
}

// Use string directly instead of EngineValue<"string">.
//
// Note that PropertyName is only represented by a EngineValue<"string">
type PropertyKey = string | EngineValue<"symbol">;

// https://tc39.es/ecma262/#sec-privateelement-specification-type
type PrivateElement =
	| {
			key: string;
			kind: "field" | "method";
			value: EngineValue;
	  }
	| {
			key: string;
			kind: "accessor";
			get: EngineValue<"object" | "undefined">;
			set: EngineValue<"object" | "undefined">;
	  };

// https://tc39.es/ecma262/#sec-object-internal-methods-and-internal-slots
type BaseInternalSlots = {
	PrivateElements: Record<string, PrivateElement>;
};

// https://tc39.es/ecma262/#sec-object-internal-methods-and-internal-slots
//
// For implementations, see https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots
export type EssentialInternalMethods = typeof OrdinaryObjectInternalMethods;

type FunctionObjectInternalSlots = {
	Call: EngineValue;
	Construct: EngineValue;
};

// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots
export type OrdinaryInternalSlots = {
	Prototype: EngineValue<"object" | "null">;
	Extensible: boolean;
};

export type InternalSlots = Partial<
	BaseInternalSlots &
		EssentialInternalMethods &
		FunctionObjectInternalSlots &
		OrdinaryInternalSlots
>;

export class ObjectPropertyMap {
	private properties: Map<PropertyKey, PropertyDescriptor> = new Map();

	has(key: PropertyKey) {
		return this.properties.has(key);
	}

	get(key: PropertyKey) {
		return this.properties.get(key)!;
	}

	set(key: PropertyKey, value: PropertyDescriptor) {
		this.properties.set(key, value);
	}
}

// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots
export const OrdinaryObjectInternalMethods = {
	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-getprototypeof
	GetPrototypeOf: (obj: EngineValue<"object">) => {
		return normalCompletion(obj.objectOrdinaryInternalSlots().Prototype);
	},

	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-setprototypeof-v
	SetPrototypeOf: (obj: EngineValue<"object">, V: EngineValue<"object" | "null">) => {
		const current = obj.objectOrdinaryInternalSlots().Prototype;

		// TODO: SameValue abstract operation;
		if (current === V) {
			return normalCompletion(EngineValue.boolean(true));
		}

		const extensible = obj.objectOrdinaryInternalSlots().Extensible;
		if (!extensible) {
			return normalCompletion(EngineValue.boolean(false));
		}

		let p = V;
		let done = false;
		while (!done) {
			if (p.isNull()) {
				done = true;
			} else if (p === obj) {
				// TODO: SameValue
				return normalCompletion(EngineValue.boolean(false));
			} else {
				if (
					!p.isObject() ||
					p.objectEssentialMethods().GetPrototypeOf !==
						OrdinaryObjectInternalMethods.GetPrototypeOf
				) {
					done = true;
				} else {
					p = p.objectOrdinaryInternalSlots().Prototype;
				}
			}
		}

		obj.objectOrdinaryInternalSlots().Prototype = V;
		return normalCompletion(EngineValue.boolean(true));
	},

	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-isextensible
	IsExtensible: (obj: EngineValue<"object">) => {
		return normalCompletion(
			EngineValue.boolean(obj.objectOrdinaryInternalSlots().Extensible),
		);
	},

	// https://tc39.es/ecma262/#sec-ordinary-object-internal-methods-and-internal-slots-setprototypeof-v
	PreventExtensions: (obj: EngineValue<"object">) => {
		obj.objectOrdinaryInternalSlots().Extensible = false;
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
};

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
	const current = obj.objectEssentialMethods().GetOwnProperty(obj, P);
	if (current.type === "throw") {
		return current;
	}

	const extensible = obj.objectEssentialMethods().IsExtensible(obj);
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
			// TODO: SameValue
			if (!isNil(Desc.get) && Desc.get !== current.get) {
				return EngineValue.boolean(false);
			}

			// TODO: SameValue
			if (!isNil(Desc.set) && Desc.set !== current.set) {
				return EngineValue.boolean(false);
			}
		}

		if (current.writable !== false) {
			if (Desc.writable === true) {
				return EngineValue.boolean(false);
			}

			if (!isNil(Desc.value)) {
				// TODO: SameValue
				return EngineValue.boolean(Desc.value === current.value);
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
	const hasOwn = obj.objectEssentialMethods().GetOwnProperty(obj, P);
	if (hasOwn.type === "throw") {
		return hasOwn;
	}

	if (hasOwn.value instanceof PropertyDescriptor) {
		return normalCompletion(EngineValue.boolean(true));
	}

	const parent = obj.objectEssentialMethods().GetPrototypeOf(obj);
	if (parent.type === "throw") {
		return parent;
	}

	if (parent.value.isObject()) {
		return parent.value.objectEssentialMethods().HasProperty(parent.value, P);
	}

	return normalCompletion(EngineValue.boolean(false));
}
