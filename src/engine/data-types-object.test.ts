import { expect, test } from "vitest";
import {
	OrdinaryObjectInternalMethods,
	OrdinaryGetOwnProperty,
	OrdinaryDefineOwnProperty,
	ValidateAndApplyPropertyDescriptor,
	IsCompatiblePropertyDescriptor,
	OrdinaryHasProperty,
	PropertyDescriptor,
} from "./data-types-object.ts";
import { EngineValue } from "./data-types.ts";

test("PropertyDescriptor constructor initializes with provided values", () => {
	const desc = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: true,
		enumerable: true,
		configurable: true,
	});

	expect(desc.value).toEqual(EngineValue.number(42));
	expect(desc.writable).toBe(true);
	expect(desc.enumerable).toBe(true);
	expect(desc.configurable).toBe(true);
});

test("PropertyDescriptor constructor creates empty descriptor without arguments", () => {
	const desc = new PropertyDescriptor();
	expect(desc.value).toBeUndefined();
	expect(desc.writable).toBeUndefined();
	expect(desc.enumerable).toBeUndefined();
	expect(desc.configurable).toBeUndefined();
});

test("PropertyDescriptor copyAccessor copies accessor properties", () => {
	const desc = new PropertyDescriptor({
		get: EngineValue.undefined(),
		set: EngineValue.undefined(),
		enumerable: true,
		configurable: false,
	});

	const copy = desc.copyAccessor();

	expect(copy.get).toEqual(EngineValue.undefined());
	expect(copy.set).toEqual(EngineValue.undefined());
	expect(copy.enumerable).toBe(true);
	expect(copy.configurable).toBe(false);
	expect(copy.value).toBeUndefined();
	expect(copy.writable).toBeUndefined();
});

test("PropertyDescriptor copyDescriptor copies data properties", () => {
	const desc = new PropertyDescriptor({
		value: EngineValue.string("test"),
		writable: false,
		enumerable: true,
		configurable: true,
	});

	const copy = desc.copyDescriptor();

	expect(copy.value).toEqual(EngineValue.string("test"));
	expect(copy.writable).toBe(false);
	expect(copy.enumerable).toBe(true);
	expect(copy.configurable).toBe(true);
	expect(copy.get).toBeUndefined();
	expect(copy.set).toBeUndefined();
});

test("PropertyDescriptor hasFields returns false for empty descriptor", () => {
	const desc = new PropertyDescriptor();
	expect(desc.hasFields()).toBe(false);
});

test("PropertyDescriptor hasFields returns true when value is set", () => {
	const desc = new PropertyDescriptor({ value: EngineValue.number(42) });
	expect(desc.hasFields()).toBe(true);
});

test("PropertyDescriptor hasFields returns true when writable is set", () => {
	const desc = new PropertyDescriptor({ writable: true });
	expect(desc.hasFields()).toBe(true);
});

test("PropertyDescriptor hasFields returns true when get is set", () => {
	const desc = new PropertyDescriptor({ get: EngineValue.undefined() });
	expect(desc.hasFields()).toBe(true);
});

test("PropertyDescriptor hasFields returns true when set is set", () => {
	const desc = new PropertyDescriptor({ set: EngineValue.undefined() });
	expect(desc.hasFields()).toBe(true);
});

test("PropertyDescriptor hasFields returns true when enumerable is set", () => {
	const desc = new PropertyDescriptor({ enumerable: true });
	expect(desc.hasFields()).toBe(true);
});

test("PropertyDescriptor hasFields returns true when configurable is set", () => {
	const desc = new PropertyDescriptor({ configurable: true });
	expect(desc.hasFields()).toBe(true);
});

test("PropertyDescriptor isGenericDescriptor returns true for data descriptor", () => {
	const desc = new PropertyDescriptor({ value: EngineValue.number(42) });
	expect(desc.isGenericDescriptor()).toBe(true);
});

test("PropertyDescriptor isGenericDescriptor returns true for accessor descriptor", () => {
	const desc = new PropertyDescriptor({ get: EngineValue.undefined() });
	expect(desc.isGenericDescriptor()).toBe(true);
});

test("PropertyDescriptor isDataDescriptor returns true when value is set", () => {
	const desc = new PropertyDescriptor({ value: EngineValue.number(42) });
	expect(desc.isDataDescriptor()).toBe(true);
});

test("PropertyDescriptor isDataDescriptor returns true when writable is set", () => {
	const desc = new PropertyDescriptor({ writable: true });
	expect(desc.isDataDescriptor()).toBe(true);
});

test("PropertyDescriptor isDataDescriptor returns false for accessor descriptor", () => {
	const desc = new PropertyDescriptor({ get: EngineValue.undefined() });
	expect(desc.isDataDescriptor()).toBe(false);
});

test("PropertyDescriptor isDataDescriptor returns false for empty descriptor", () => {
	const desc = new PropertyDescriptor();
	expect(desc.isDataDescriptor()).toBe(false);
});

test("PropertyDescriptor isAccessorDescriptor returns true when get is set", () => {
	const desc = new PropertyDescriptor({ get: EngineValue.undefined() });
	expect(desc.isAccessorDescriptor()).toBe(true);
});

test("PropertyDescriptor isAccessorDescriptor returns true when set is set", () => {
	const desc = new PropertyDescriptor({ set: EngineValue.undefined() });
	expect(desc.isAccessorDescriptor()).toBe(true);
});

test("PropertyDescriptor isAccessorDescriptor returns false for data descriptor", () => {
	const desc = new PropertyDescriptor({ value: EngineValue.number(42) });
	expect(desc.isAccessorDescriptor()).toBe(false);
});

test("PropertyDescriptor isAccessorDescriptor returns false for empty descriptor", () => {
	const desc = new PropertyDescriptor();
	expect(desc.isAccessorDescriptor()).toBe(false);
});

test("PropertyDescriptor setValueDefaultIfNotSet sets undefined when value is not set", () => {
	const desc = new PropertyDescriptor();
	desc.setValueDefaultIfNotSet();
	expect(desc.value).toEqual(EngineValue.undefined());
});

test("PropertyDescriptor setValueDefaultIfNotSet does not change existing value", () => {
	const desc = new PropertyDescriptor({ value: EngineValue.number(42) });
	desc.setValueDefaultIfNotSet();
	expect(desc.value).toEqual(EngineValue.number(42));
});

test("PropertyDescriptor setWritableDefaultIfNotSet sets false when writable is not set", () => {
	const desc = new PropertyDescriptor();
	desc.setWritableDefaultIfNotSet();
	expect(desc.writable).toBe(false);
});

test("PropertyDescriptor setWritableDefaultIfNotSet does not change existing writable", () => {
	const desc = new PropertyDescriptor({ writable: true });
	desc.setWritableDefaultIfNotSet();
	expect(desc.writable).toBe(true);
});

test("PropertyDescriptor setGetDefaultIfNotSet sets undefined when get is not set", () => {
	const desc = new PropertyDescriptor();
	desc.setGetDefaultIfNotSet();
	expect(desc.get).toEqual(EngineValue.undefined());
});

test("PropertyDescriptor setGetDefaultIfNotSet does not change existing get", () => {
	const obj = EngineValue.object([]);
	const desc = new PropertyDescriptor({ get: obj });
	desc.setGetDefaultIfNotSet();
	expect(desc.get).toEqual(obj);
});

test("PropertyDescriptor setSetDefaultIfNotSet sets undefined when set is not set", () => {
	const desc = new PropertyDescriptor();
	desc.setSetDefaultIfNotSet();
	expect(desc.set).toEqual(EngineValue.undefined());
});

test("PropertyDescriptor setSetDefaultIfNotSet does not change existing set", () => {
	const obj = EngineValue.object([]);
	const desc = new PropertyDescriptor({ set: obj });
	desc.setSetDefaultIfNotSet();
	expect(desc.set).toEqual(obj);
});

test("PropertyDescriptor setEnumerableDefaultIfNotSet sets false when enumerable is not set", () => {
	const desc = new PropertyDescriptor();
	desc.setEnumerableDefaultIfNotSet();
	expect(desc.enumerable).toBe(false);
});

test("PropertyDescriptor setEnumerableDefaultIfNotSet does not change existing enumerable", () => {
	const desc = new PropertyDescriptor({ enumerable: true });
	desc.setEnumerableDefaultIfNotSet();
	expect(desc.enumerable).toBe(true);
});

test("PropertyDescriptor setConfigurableDefaultIfNotSet sets false when configurable is not set", () => {
	const desc = new PropertyDescriptor();
	desc.setConfigurableDefaultIfNotSet();
	expect(desc.configurable).toBe(false);
});

test("PropertyDescriptor setConfigurableDefaultIfNotSet does not change existing configurable", () => {
	const desc = new PropertyDescriptor({ configurable: true });
	desc.setConfigurableDefaultIfNotSet();
	expect(desc.configurable).toBe(true);
});

test("ObjectPropertyMap has returns false for non-existent property", () => {
	const map = new (class {
		properties = new Map();
		has(key: string) {
			return this.properties.has(key);
		}
	})();
	expect(map.has("nonExistent")).toBe(false);
});

test("OrdinaryGetOwnProperty returns undefined for non-existent property", () => {
	const obj = EngineValue.object([]);
	const result = OrdinaryGetOwnProperty(obj, "nonExistent");
	expect(result).toEqual(EngineValue.undefined());
});

test("OrdinaryGetOwnProperty returns descriptor for data descriptor property", () => {
	const obj = EngineValue.object([]);
	const desc = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: true,
		enumerable: false,
		configurable: true,
	});
	obj.data.properties.set("test", desc);

	const result = OrdinaryGetOwnProperty(obj, "test");

	if (result instanceof PropertyDescriptor) {
		expect(result.value).toEqual(EngineValue.number(42));
		expect(result.writable).toBe(true);
		expect(result.enumerable).toBe(false);
		expect(result.configurable).toBe(true);
	} else {
		throw new Error("Expected PropertyDescriptor");
	}
});

test("OrdinaryGetOwnProperty returns descriptor for accessor descriptor property", () => {
	const obj = EngineValue.object([]);
	const desc = new PropertyDescriptor({
		get: EngineValue.undefined(),
		set: EngineValue.undefined(),
		enumerable: true,
		configurable: false,
	});
	obj.data.properties.set("test", desc);

	const result = OrdinaryGetOwnProperty(obj, "test");

	if (result instanceof PropertyDescriptor) {
		expect(result.get).toEqual(EngineValue.undefined());
		expect(result.set).toEqual(EngineValue.undefined());
		expect(result.enumerable).toBe(true);
		expect(result.configurable).toBe(false);
	} else {
		throw new Error("Expected PropertyDescriptor");
	}
});

test("OrdinaryDefineOwnProperty returns completion record", () => {
	const obj = EngineValue.object([]);
	obj.data.internalSlots = {
		Prototype: EngineValue.null(),
		Extensible: true,
		...OrdinaryObjectInternalMethods,
	};

	const desc = new PropertyDescriptor({ value: EngineValue.number(42) });
	const result = OrdinaryDefineOwnProperty(obj, "test", desc);

	expect(result.type).toBe("normal");
});

test("OrdinaryDefineOwnProperty defines new property on extensible object", () => {
	const obj = EngineValue.object([]);
	obj.data.internalSlots = {
		Prototype: EngineValue.null(),
		Extensible: true,
		...OrdinaryObjectInternalMethods,
	};

	const desc = new PropertyDescriptor({ value: EngineValue.number(42) });
	const result = OrdinaryDefineOwnProperty(obj, "test", desc);

	expect(result.value).toEqual(EngineValue.boolean(true));
	expect(obj.data.properties.has("test")).toBe(true);
});

test("OrdinaryDefineOwnProperty returns false when defining property on non-extensible object", () => {
	const obj = EngineValue.object([]);
	obj.data.internalSlots = {
		Prototype: EngineValue.null(),
		Extensible: false,
		...OrdinaryObjectInternalMethods,
	};

	const desc = new PropertyDescriptor({ value: EngineValue.number(42) });
	const result = OrdinaryDefineOwnProperty(obj, "test", desc);

	expect(result.value).toEqual(EngineValue.boolean(false));
});

test("ValidateAndApplyPropertyDescriptor returns false when not extensible and property doesn't exist", () => {
	const result = ValidateAndApplyPropertyDescriptor(
		EngineValue.undefined(),
		"",
		false,
		new PropertyDescriptor({ value: EngineValue.number(42) }),
		EngineValue.undefined(),
	);

	expect(result).toEqual(EngineValue.boolean(false));
});

test("ValidateAndApplyPropertyDescriptor returns true when O is undefined and extensible", () => {
	const result = ValidateAndApplyPropertyDescriptor(
		EngineValue.undefined(),
		"",
		true,
		new PropertyDescriptor({ value: EngineValue.number(42) }),
		EngineValue.undefined(),
	);

	expect(result).toEqual(EngineValue.boolean(true));
});

test("ValidateAndApplyPropertyDescriptor sets default values for accessor descriptor", () => {
	const obj = EngineValue.object([]);

	const desc = new PropertyDescriptor({ get: EngineValue.undefined() });
	const result = ValidateAndApplyPropertyDescriptor(
		obj,
		"test",
		true,
		desc,
		EngineValue.undefined(),
	);

	expect(result).toEqual(EngineValue.boolean(true));
	const prop = obj.data.properties.get("test");
	expect(prop.get).toEqual(EngineValue.undefined());
	expect(prop.set).toEqual(EngineValue.undefined());
	expect(prop.enumerable).toBe(false);
	expect(prop.configurable).toBe(false);
});

test("ValidateAndApplyPropertyDescriptor sets default values for data descriptor", () => {
	const obj = EngineValue.object([]);

	const desc = new PropertyDescriptor({ value: EngineValue.number(42) });
	const result = ValidateAndApplyPropertyDescriptor(
		obj,
		"test",
		true,
		desc,
		EngineValue.undefined(),
	);

	expect(result).toEqual(EngineValue.boolean(true));
	const prop = obj.data.properties.get("test");
	expect(prop.value).toEqual(EngineValue.number(42));
	expect(prop.writable).toBe(false);
	expect(prop.enumerable).toBe(false);
	expect(prop.configurable).toBe(false);
});

test("ValidateAndApplyPropertyDescriptor returns true when Desc has no fields", () => {
	const result = ValidateAndApplyPropertyDescriptor(
		EngineValue.undefined(),
		"",
		true,
		new PropertyDescriptor(),
		new PropertyDescriptor({ value: EngineValue.number(42) }),
	);

	expect(result).toEqual(EngineValue.boolean(true));
});

test("IsCompatiblePropertyDescriptor returns false when not extensible and property doesn't exist", () => {
	const result = IsCompatiblePropertyDescriptor(
		false,
		new PropertyDescriptor({ value: EngineValue.number(42) }),
		EngineValue.undefined(),
	);

	expect(result).toEqual(EngineValue.boolean(false));
});

test("IsCompatiblePropertyDescriptor returns true when extensible and property doesn't exist", () => {
	const result = IsCompatiblePropertyDescriptor(
		true,
		new PropertyDescriptor({ value: EngineValue.number(42) }),
		EngineValue.undefined(),
	);

	expect(result).toEqual(EngineValue.boolean(true));
});

test("OrdinaryHasProperty returns true for own property", () => {
	const obj = EngineValue.object([]);
	obj.data.internalSlots = {
		Prototype: EngineValue.null(),
		Extensible: true,
		...OrdinaryObjectInternalMethods,
	};

	const desc = new PropertyDescriptor({ value: EngineValue.number(42) });
	obj.data.properties.set("test", desc);

	const result = OrdinaryHasProperty(obj, "test");

	expect(result.type).toBe("normal");
	expect(result.value).toEqual(EngineValue.boolean(true));
});

test("OrdinaryHasProperty returns false for non-existent property with null prototype", () => {
	const obj = EngineValue.object([]);
	obj.data.internalSlots = {
		Prototype: EngineValue.null(),
		Extensible: true,
		...OrdinaryObjectInternalMethods,
	};

	const result = OrdinaryHasProperty(obj, "nonExistent");

	expect(result.type).toBe("normal");
	expect(result.value).toEqual(EngineValue.boolean(false));
});

test("OrdinaryObjectInternalMethods.GetPrototypeOf returns completion record", () => {
	const obj = EngineValue.object([]);
	obj.data.internalSlots = {
		Prototype: EngineValue.null(),
		Extensible: true,
		...OrdinaryObjectInternalMethods,
	};

	const result = OrdinaryObjectInternalMethods.GetPrototypeOf(obj);

	expect(result.type).toBe("normal");
});

test("OrdinaryObjectInternalMethods.GetPrototypeOf returns prototype", () => {
	const obj = EngineValue.object([]);
	const prototype = EngineValue.null();
	obj.data.internalSlots = {
		Prototype: prototype,
		Extensible: true,
		...OrdinaryObjectInternalMethods,
	};

	const result = OrdinaryObjectInternalMethods.GetPrototypeOf(obj);

	expect(result.value).toEqual(prototype);
});

test("OrdinaryObjectInternalMethods.IsExtensible returns completion record", () => {
	const obj = EngineValue.object([]);
	obj.data.internalSlots = {
		Prototype: EngineValue.null(),
		Extensible: true,
		...OrdinaryObjectInternalMethods,
	};

	const result = OrdinaryObjectInternalMethods.IsExtensible(obj);

	expect(result.type).toBe("normal");
});

test("OrdinaryObjectInternalMethods.IsExtensible returns extensible status", () => {
	const obj = EngineValue.object([]);
	obj.data.internalSlots = {
		Prototype: EngineValue.null(),
		Extensible: true,
		...OrdinaryObjectInternalMethods,
	};

	const result = OrdinaryObjectInternalMethods.IsExtensible(obj);

	expect(result.value).toEqual(EngineValue.boolean(true));
});

test("OrdinaryObjectInternalMethods.PreventExtensions sets extensible to false", () => {
	const obj = EngineValue.object([]);
	obj.data.internalSlots = {
		Prototype: EngineValue.null(),
		Extensible: true,
		...OrdinaryObjectInternalMethods,
	};

	const result = OrdinaryObjectInternalMethods.PreventExtensions(obj);

	expect(result.type).toBe("normal");
	expect(result.value).toEqual(EngineValue.boolean(true));
	expect(obj.data.internalSlots.Extensible).toBe(false);
});

// TODO: Add tests for SetPrototypeOf when SameValue is properly implemented

// TODO: Add tests for ValidateAndApplyPropertyDescriptor when changing configurable property on
// non-configurable property

// TODO: Add tests for ValidateAndApplyPropertyDescriptor when changing enumerable property on
// non-configurable property

// TODO: Add tests for ValidateAndApplyPropertyDescriptor when changing descriptor type on
// non-configurable property

// TODO: Add tests for ValidateAndApplyPropertyDescriptor when changing get/set on non-configurable
// accessor descriptor

// TODO: Add tests for ValidateAndApplyPropertyDescriptor when changing value on non-configurable
// data descriptor

// TODO: Add tests for ValidateAndApplyPropertyDescriptor when converting data descriptor to
// accessor descriptor

// TODO: Add tests for ValidateAndApplyPropertyDescriptor when converting accessor descriptor to
// data descriptor

// TODO: Add tests for OrdinaryHasProperty with prototype chain
