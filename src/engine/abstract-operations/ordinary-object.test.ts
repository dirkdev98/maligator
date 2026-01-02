import { expect, test } from "vitest";
import { EngineValue } from "../data-types.ts";
import {
	isCompatiblePropertyDescriptor,
	ordinaryDefineOwnProperty,
	ordinaryGetOwnProperty,
	ordinaryHasProperty,
	OrdinaryObjectInternalMethods,
	validateAndApplyPropertyDescriptor,
} from "./ordinary-object.ts";
import { PropertyDescriptor } from "./property-map.ts";

test("OrdinaryGetOwnProperty returns undefined for non-existent property", () => {
	const obj = EngineValue.object([]);
	const result = ordinaryGetOwnProperty(obj, "nonExistent");
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

	const result = ordinaryGetOwnProperty(obj, "test");

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

	const result = ordinaryGetOwnProperty(obj, "test");

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
	const result = ordinaryDefineOwnProperty(obj, "test", desc);

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
	const result = ordinaryDefineOwnProperty(obj, "test", desc);

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
	const result = ordinaryDefineOwnProperty(obj, "test", desc);

	expect(result.value).toEqual(EngineValue.boolean(false));
});

test("ValidateAndApplyPropertyDescriptor returns false when not extensible and property doesn't exist", () => {
	const result = validateAndApplyPropertyDescriptor(
		EngineValue.undefined(),
		"",
		false,
		new PropertyDescriptor({ value: EngineValue.number(42) }),
		EngineValue.undefined(),
	);

	expect(result).toEqual(EngineValue.boolean(false));
});

test("ValidateAndApplyPropertyDescriptor returns true when O is undefined and extensible", () => {
	const result = validateAndApplyPropertyDescriptor(
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
	const result = validateAndApplyPropertyDescriptor(
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
	const result = validateAndApplyPropertyDescriptor(
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
	const result = validateAndApplyPropertyDescriptor(
		EngineValue.undefined(),
		"",
		true,
		new PropertyDescriptor(),
		new PropertyDescriptor({ value: EngineValue.number(42) }),
	);

	expect(result).toEqual(EngineValue.boolean(true));
});

test("IsCompatiblePropertyDescriptor returns false when not extensible and property doesn't exist", () => {
	const result = isCompatiblePropertyDescriptor(
		false,
		new PropertyDescriptor({ value: EngineValue.number(42) }),
		EngineValue.undefined(),
	);

	expect(result).toEqual(EngineValue.boolean(false));
});

test("IsCompatiblePropertyDescriptor returns true when extensible and property doesn't exist", () => {
	const result = isCompatiblePropertyDescriptor(
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

	const result = ordinaryHasProperty(obj, "test");

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

	const result = ordinaryHasProperty(obj, "nonExistent");

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

test("OrdinaryObjectInternalMethods.SetPrototypeOf returns true when setting same prototype", () => {
	const obj = EngineValue.object([]);
	obj.data.internalSlots = {
		Prototype: EngineValue.null(),
		Extensible: true,
		...OrdinaryObjectInternalMethods,
	};

	const prototype = EngineValue.null();
	const result = OrdinaryObjectInternalMethods.SetPrototypeOf(obj, prototype);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(true);
	}
});

test("OrdinaryObjectInternalMethods.SetPrototypeOf returns true for same object reference as prototype", () => {
	const prototype = EngineValue.object([]);
	const obj = EngineValue.object([]);
	obj.data.internalSlots = {
		Prototype: prototype,
		Extensible: true,
		...OrdinaryObjectInternalMethods,
	};

	const result = OrdinaryObjectInternalMethods.SetPrototypeOf(obj, prototype);

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(true);
	}
});

test("ValidateAndApplyPropertyDescriptor returns true when Desc get is same as current get on non-configurable accessor", () => {
	const obj = EngineValue.object([]);
	const current = new PropertyDescriptor({
		get: EngineValue.undefined(),
		set: EngineValue.undefined(),
		enumerable: true,
		configurable: false,
	});

	const result = validateAndApplyPropertyDescriptor(
		obj,
		"test",
		true,
		new PropertyDescriptor({ get: EngineValue.undefined() }),
		current,
	);

	expect(result.data.value).toBe(true);
});

test("ValidateAndApplyPropertyDescriptor returns false when Desc get differs from current get on non-configurable accessor", () => {
	const obj = EngineValue.object([]);
	const getFn = EngineValue.object([]);
	const current = new PropertyDescriptor({
		get: getFn,
		set: EngineValue.undefined(),
		enumerable: true,
		configurable: false,
	});

	const result = validateAndApplyPropertyDescriptor(
		obj,
		"test",
		true,
		new PropertyDescriptor({ get: EngineValue.object([]) }),
		current,
	);

	expect(result.data.value).toBe(false);
});

test("ValidateAndApplyPropertyDescriptor returns true when Desc set is same as current set on non-configurable accessor", () => {
	const obj = EngineValue.object([]);
	const current = new PropertyDescriptor({
		get: EngineValue.undefined(),
		set: EngineValue.undefined(),
		enumerable: true,
		configurable: false,
	});

	const result = validateAndApplyPropertyDescriptor(
		obj,
		"test",
		true,
		new PropertyDescriptor({ set: EngineValue.undefined() }),
		current,
	);

	expect(result.data.value).toBe(true);
});

test("ValidateAndApplyPropertyDescriptor returns false when Desc set differs from current set on non-configurable accessor", () => {
	const obj = EngineValue.object([]);
	const setFn = EngineValue.object([]);
	const current = new PropertyDescriptor({
		get: EngineValue.undefined(),
		set: setFn,
		enumerable: true,
		configurable: false,
	});

	const result = validateAndApplyPropertyDescriptor(
		obj,
		"test",
		true,
		new PropertyDescriptor({ set: EngineValue.object([]) }),
		current,
	);

	expect(result.data.value).toBe(false);
});

test("ValidateAndApplyPropertyDescriptor returns true when Desc value is same as current value on non-configurable, non-writable data descriptor", () => {
	const obj = EngineValue.object([]);
	const current = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: false,
		enumerable: true,
		configurable: false,
	});

	const result = validateAndApplyPropertyDescriptor(
		obj,
		"test",
		true,
		new PropertyDescriptor({ value: EngineValue.number(42) }),
		current,
	);

	expect(result.data.value).toBe(true);
});

test.skip("ValidateAndApplyPropertyDescriptor returns false when Desc value differs from current value on non-configurable, non-writable data descriptor", () => {
	const obj = EngineValue.object([]);
	const current = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: false,
		enumerable: true,
		configurable: false,
	});

	const result = validateAndApplyPropertyDescriptor(
		obj,
		"test",
		true,
		new PropertyDescriptor({ value: EngineValue.number(100) }),
		current,
	);

	expect(result.data.value).toBe(false);
});

test("ValidateAndApplyPropertyDescriptor uses sameValue semantics for NaN comparison", () => {
	const obj = EngineValue.object([]);
	const current = new PropertyDescriptor({
		value: EngineValue.number(NaN),
		writable: false,
		enumerable: true,
		configurable: false,
	});

	const result = validateAndApplyPropertyDescriptor(
		obj,
		"test",
		true,
		new PropertyDescriptor({ value: EngineValue.number(NaN) }),
		current,
	);

	expect(result.data.value).toBe(true);
});

test.skip("ValidateAndApplyPropertyDescriptor distinguishes positive and negative zero using sameValue", () => {
	const obj = EngineValue.object([]);
	const current = new PropertyDescriptor({
		value: EngineValue.number(0),
		writable: false,
		enumerable: true,
		configurable: false,
	});

	const result = validateAndApplyPropertyDescriptor(
		obj,
		"test",
		true,
		new PropertyDescriptor({ value: EngineValue.number(-0) }),
		current,
	);

	expect(result.data.value).toBe(false);
});

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
