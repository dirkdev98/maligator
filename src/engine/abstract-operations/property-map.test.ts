import { expect, test } from "vitest";
import { EngineValue } from "../data-types.ts";
import { PropertyDescriptor } from "./property-map.ts";

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
