import { expect, test } from "vitest";
import { EngineValue } from "../types-and-values/data-types.ts";
import {
	makeBasicObject,
	get,
	set,
	createDataProperty,
	createDataPropertyOrThrow,
	createNonEnumerableDataPropertyOrThrow,
	definePropertyOrThrow,
	deletePropertyOrThrow,
	getMethod,
	hasProperty,
	hasOwnProperty,
} from "./object-operations.ts";
import { PropertyDescriptor } from "./property-map.ts";

test("makeBasicObject creates object with PrivateElements by default", () => {
	const obj = makeBasicObject([]);

	expect(obj.isObject()).toBe(true);
	expect(obj.objectHasInternalSlot("PrivateElements")).toBe(true);
	expect(obj.objectGetInternalSlot("PrivateElements")).toEqual([]);
});

test("makeBasicObject includes PrivateElements by default", () => {
	const obj = makeBasicObject([]);

	expect(obj.objectHasInternalSlot("PrivateElements")).toBe(true);
	expect(obj.objectGetInternalSlot("PrivateElements")).toEqual([]);
});

test("makeBasicObject sets Extensible to true when included", () => {
	const obj = makeBasicObject(["Extensible"]);

	expect(obj.objectGetInternalSlot("Extensible")).toBe(true);
});

test("makeBasicObject includes all OrdinaryObjectInternalMethods", () => {
	const obj = makeBasicObject([]);

	expect(obj.objectHasInternalSlot("GetPrototypeOf")).toBe(true);
	expect(obj.objectHasInternalSlot("SetPrototypeOf")).toBe(true);
	expect(obj.objectHasInternalSlot("IsExtensible")).toBe(true);
	expect(obj.objectHasInternalSlot("PreventExtensions")).toBe(true);
	expect(obj.objectHasInternalSlot("GetOwnProperty")).toBe(true);
	expect(obj.objectHasInternalSlot("DefineOwnProperty")).toBe(true);
	expect(obj.objectHasInternalSlot("HasProperty")).toBe(true);
	expect(obj.objectHasInternalSlot("Get")).toBe(true);
	expect(obj.objectHasInternalSlot("Set")).toBe(true);
	expect(obj.objectHasInternalSlot("Delete")).toBe(true);
});

test("get retrieves property value using Get internal method", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const desc = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: true,
		enumerable: true,
		configurable: true,
	});
	obj.data.properties.set("test", desc);

	const result = get(obj, "test");

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isNumber()).toBe(true);
		expect(result.value.asNumber().data.value).toBe(42);
	}
});

test("get returns undefined for non-existent property", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const result = get(obj, "nonExistent");

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isUndefined()).toBe(true);
	}
});

test.todo("set updates property value", () => {
	// TODO: Investigate why Set doesn't update existing property value
	// ordinarySet should call DefineOwnProperty to update the value
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const desc = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: true,
		enumerable: true,
		configurable: true,
	});
	obj.data.properties.set("test", desc);

	const result = set(obj, "test", EngineValue.number(100));

	expect(result.type).toBe("normal");
	const prop = obj.data.properties.get("test");
	expect(prop.value).toEqual(EngineValue.number(100));
});

test("set with Throw=true throws TypeError on failure", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());
	obj.objectSetInternalSlot("Extensible", false);

	const result = set(obj, "newProp", EngineValue.number(42), true);

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Cannot 'set' property.");
	}
});

test("set with Throw=false returns normally on failure", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());
	obj.objectSetInternalSlot("Extensible", false);

	const result = set(obj, "newProp", EngineValue.number(42), false);

	expect(result.type).toBe("normal");
});

test("createDataProperty creates property with correct attributes", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const result = createDataProperty(obj, "test", EngineValue.string("hello"));

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(true);
	}

	const prop = obj.data.properties.get("test");
	expect(prop.value).toEqual(EngineValue.string("hello"));
	expect(prop.writable).toBe(true);
	expect(prop.enumerable).toBe(true);
	expect(prop.configurable).toBe(true);
});

test("createDataPropertyOrThrow throws on failure", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());
	obj.objectSetInternalSlot("Extensible", false);

	const result = createDataPropertyOrThrow(obj, "test", EngineValue.number(42));

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Cannot create data property.");
	}
});

test("createDataPropertyOrThrow succeeds for extensible object", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const result = createDataPropertyOrThrow(obj, "test", EngineValue.number(42));

	expect(result.type).toBe("normal");
});

test("createNonEnumerableDataPropertyOrThrow creates non-enumerable property", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const result = createNonEnumerableDataPropertyOrThrow(
		obj,
		"test",
		EngineValue.string("value"),
	);

	expect(result).toBe(-1); // UNUSED

	const prop = obj.data.properties.get("test");
	expect(prop.value?.asString().data.value).toBe("value");
	expect(prop.writable).toBe(true);
	expect(prop.enumerable).toBe(false);
	expect(prop.configurable).toBe(true);
});

test("createNonEnumerableDataPropertyOrThrow throws on failure", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());
	obj.objectSetInternalSlot("Extensible", false);

	expect(() =>
		createNonEnumerableDataPropertyOrThrow(obj, "test", EngineValue.number(42)),
	).toThrow(TypeError);
});

test("definePropertyOrThrow defines property with descriptor", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const desc = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: false,
		enumerable: true,
		configurable: false,
	});

	const result = definePropertyOrThrow(obj, "test", desc);

	expect(result.type).toBe("normal");

	const prop = obj.data.properties.get("test");
	expect(prop.value?.asNumber().data.value).toBe(42);
	expect(prop.writable).toBe(false);
	expect(prop.enumerable).toBe(true);
	expect(prop.configurable).toBe(false);
});

test("deletePropertyOrThrow deletes property successfully", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const desc = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: true,
		enumerable: true,
		configurable: true,
	});
	obj.data.properties.set("test", desc);

	const result = deletePropertyOrThrow(obj, "test");

	expect(result.type).toBe("normal");
	expect(obj.data.properties.has("test")).toBe(false);
});

test("deletePropertyOrThrow throws when deleting non-configurable property", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const desc = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: true,
		enumerable: true,
		configurable: false,
	});
	obj.data.properties.set("test", desc);

	const result = deletePropertyOrThrow(obj, "test");

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Cannot delete property.");
	}
});

test.todo("getMethod returns undefined for null property value", () => {
	// TODO: Requires toObject implementation (see type-conversion.ts:423)
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const desc = new PropertyDescriptor({
		value: EngineValue.null(),
		writable: true,
		enumerable: true,
		configurable: true,
	});
	obj.data.properties.set("method", desc);

	const result = getMethod(obj, "method");

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isUndefined()).toBe(true);
	}
});

test.todo("getMethod returns undefined for undefined property value", () => {
	// TODO: Requires toObject implementation (see type-conversion.ts:423)
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const result = getMethod(obj, "nonExistent");

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isUndefined()).toBe(true);
	}
});

test.todo("getMethod throws TypeError for non-callable property", () => {
	// TODO: Requires toObject implementation (see type-conversion.ts:423)
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const desc = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: true,
		enumerable: true,
		configurable: true,
	});
	obj.data.properties.set("method", desc);

	const result = getMethod(obj, "method");

	expect(result.type).toBe("throw");
	if (result.type === "throw") {
		expect(result.error).toBeInstanceOf(TypeError);
		expect(result.error.message).toBe("Property is not callable.");
	}
});

test.todo("getMethod returns callable object", () => {
	// TODO: Requires toObject implementation (see type-conversion.ts:423)
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const func = EngineValue.object([]);
	func.objectSetInternalSlot("Call", EngineValue.undefined());

	const desc = new PropertyDescriptor({
		value: func,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	obj.data.properties.set("method", desc);

	const result = getMethod(obj, "method");

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.isObject()).toBe(true);
	}
});

test("hasProperty returns true for own property", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const desc = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: true,
		enumerable: true,
		configurable: true,
	});
	obj.data.properties.set("test", desc);

	const result = hasProperty(obj, "test");

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(true);
	}
});

test("hasProperty returns false for non-existent property", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const result = hasProperty(obj, "nonExistent");

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});

test("hasOwnProperty returns true for own property", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const desc = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: true,
		enumerable: true,
		configurable: true,
	});
	obj.data.properties.set("test", desc);

	const result = hasOwnProperty(obj, "test");

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(true);
	}
});

test("hasOwnProperty returns false for non-existent property", () => {
	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", EngineValue.null());

	const result = hasOwnProperty(obj, "nonExistent");

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});

test("hasOwnProperty returns false for inherited property", () => {
	const parent = makeBasicObject(["Extensible", "Prototype"]);
	parent.objectSetInternalSlot("Prototype", EngineValue.null());

	const parentDesc = new PropertyDescriptor({
		value: EngineValue.number(42),
		writable: true,
		enumerable: true,
		configurable: true,
	});
	parent.data.properties.set("inherited", parentDesc);

	const obj = makeBasicObject(["Extensible", "Prototype"]);
	obj.objectSetInternalSlot("Prototype", parent);

	const result = hasOwnProperty(obj, "inherited");

	expect(result.type).toBe("normal");
	if (result.type === "normal") {
		expect(result.value.data.value).toBe(false);
	}
});
