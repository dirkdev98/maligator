import { expect, test } from "vitest";
import { EngineValue } from "../data-types.ts";
import {
	IsCompatiblePropertyDescriptor,
	OrdinaryDefineOwnProperty,
	OrdinaryGetOwnProperty,
	OrdinaryHasProperty,
	OrdinaryObjectInternalMethods,
	ValidateAndApplyPropertyDescriptor,
} from "./ordinary-object.ts";
import { PropertyDescriptor } from "./property-map.ts";

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

test.todo(
	"OrdinaryObjectInternalMethods.SetPrototypeOf sets prototype when SameValue returns false and object is extensible",
);

test.todo(
	"OrdinaryObjectInternalMethods.SetPrototypeOf returns false when trying to set circular prototype",
);

test.todo(
	"OrdinaryObjectInternalMethods.SetPrototypeOf returns false when object is not extensible",
);

test.todo(
	"ValidateAndApplyPropertyDescriptor returns false when changing configurable on non-configurable property",
);

test.todo(
	"ValidateAndApplyPropertyDescriptor returns false when changing enumerable on non-configurable property",
);

test.todo(
	"ValidateAndApplyPropertyDescriptor returns false when changing descriptor type on non-configurable property",
);

test.todo(
	"ValidateAndApplyPropertyDescriptor returns false when changing get on non-configurable accessor descriptor",
);

test.todo(
	"ValidateAndApplyPropertyDescriptor returns false when changing set on non-configurable accessor descriptor",
);

test.todo(
	"ValidateAndApplyPropertyDescriptor returns false when changing value on non-configurable data descriptor when writable is false",
);

test.todo(
	"ValidateAndApplyPropertyDescriptor converts data descriptor to accessor descriptor on configurable property",
);

test.todo(
	"ValidateAndApplyPropertyDescriptor converts accessor descriptor to data descriptor on configurable property",
);

test.todo(
	"ValidateAndApplyPropertyDescriptor updates existing property when Desc has fields",
);

test.todo("OrdinaryHasProperty returns true for property from prototype chain");

test.todo(
	"OrdinaryHasProperty returns false when property is not found in prototype chain",
);
