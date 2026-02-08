import { isNil } from "../../utils.ts";
import { getCurrentRealm } from "../execution-contexts/execution-context.ts";
import {
	normalCompletion,
	throwCompletion,
	unwrapCompletion,
} from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { createDataPropertyOrThrow, get, hasProperty } from "./object-operations.ts";
import { ordinaryObjectCreate } from "./ordinary-object.ts";
import { isCallable } from "./testing-and-comparison.ts";
import { toBoolean } from "./type-conversion.ts";

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

	// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-frompropertydescriptor
	static fromPropertyDescriptor(desc?: PropertyDescriptor | EngineValue<"undefined">) {
		if (isNil(desc) || (desc instanceof EngineValue && desc.isUndefined())) {
			return EngineValue.undefined();
		}

		const obj = ordinaryObjectCreate(
			getCurrentRealm().intrinsics["%Object.prototype%"]!.asObject(),
		);

		if (!isNil(desc.value)) {
			createDataPropertyOrThrow(obj, "value", desc.value);
		}

		if (!isNil(desc.writable)) {
			createDataPropertyOrThrow(obj, "writable", EngineValue.boolean(desc.writable));
		}

		if (!isNil(desc.get)) {
			createDataPropertyOrThrow(obj, "get", desc.get);
		}

		if (!isNil(desc.set)) {
			createDataPropertyOrThrow(obj, "set", desc.set);
		}

		if (!isNil(desc.enumerable)) {
			createDataPropertyOrThrow(obj, "enumerable", EngineValue.boolean(desc.enumerable));
		}

		if (!isNil(desc.configurable)) {
			createDataPropertyOrThrow(
				obj,
				"configurable",
				EngineValue.boolean(desc.configurable),
			);
		}

		return obj;
	}

	// https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-topropertydescriptor
	static toPropertyDescriptor(obj: EngineValue) {
		if (!obj.isObject()) {
			return throwCompletion(new TypeError("PropertyDescriptor input is not an object."));
		}

		const desc = new PropertyDescriptor();

		const hasEnumerable = unwrapCompletion(hasProperty(obj, "enumerable"));
		if (hasEnumerable.data.value) {
			const enumerable = toBoolean(unwrapCompletion(get(obj, "enumerable")));
			desc.enumerable = enumerable.data.value;
		}

		const hasConfigurable = unwrapCompletion(hasProperty(obj, "configurable"));
		if (hasConfigurable.data.value) {
			const configurable = toBoolean(unwrapCompletion(get(obj, "configurable")));
			desc.configurable = configurable.data.value;
		}

		const hasValue = unwrapCompletion(hasProperty(obj, "value"));
		if (hasValue.data.value) {
			const value = unwrapCompletion(get(obj, "value"));
			desc.value = value;
		}

		const hasWritable = unwrapCompletion(hasProperty(obj, "writable"));
		if (hasWritable.data.value) {
			const writable = toBoolean(unwrapCompletion(get(obj, "writable")));
			desc.writable = writable.data.value;
		}

		const hasGet = unwrapCompletion(hasProperty(obj, "get"));
		if (hasGet.data.value) {
			const getter = unwrapCompletion(get(obj, "get"));
			if (!isCallable(getter).data.value && !getter.isUndefined()) {
				return throwCompletion(new TypeError("PropertyDescriptor get is not callable."));
			}
			desc.get = getter.asObject();
		}

		const hasSet = unwrapCompletion(hasProperty(obj, "set"));
		if (hasSet.data.value) {
			const setter = unwrapCompletion(get(obj, "set"));
			if (!isCallable(setter).data.value && !setter.isUndefined()) {
				return throwCompletion(new TypeError("PropertyDescriptor set is not callable."));
			}
			desc.set = setter.asObject();
		}

		if (
			(desc.get !== undefined || desc.set !== undefined) &&
			(desc.value !== undefined || desc.writable !== undefined)
		) {
			return throwCompletion(
				new TypeError("PropertyDescriptor cannot have both get/set and value/writable."),
			);
		}

		return normalCompletion(desc);
	}

	// TODO: https://tc39.es/ecma262/#sec-completepropertydescriptor
}

// Use string directly instead of EngineValue<"string">.
//
// Note that PropertyName is only represented by a EngineValue<"string">
export type PropertyKey = string | EngineValue<"symbol">;

export function isPropertyKey(
	value: unknown,
): value is string | EngineValue<"string" | "symbol"> {
	return (
		typeof value === "string" ||
		(value instanceof EngineValue && (value.type === "string" || value.type === "symbol"))
	);
}

export function unwrapPropertyKey(value: unknown): PropertyKey {
	if (!isPropertyKey(value)) {
		throw new Error("Unknown value.");
	}

	if (typeof value === "string") {
		return value;
	}

	if (value.isString()) {
		return value.data.value;
	}

	return value.asSymbol();
}

export class PropertyMap {
	private properties: Map<PropertyKey, PropertyDescriptor> = new Map();
	private arrayIndexProperties: Array<string> = [];

	static isArrayIndexProperty(key: PropertyKey): key is string {
		return (
			typeof key === "string" &&
			parseInt(key, 10).toString() === key &&
			parseInt(key, 10) < 2 ** 32 - 1
		);
	}

	has(key: PropertyKey) {
		return this.properties.has(key);
	}

	get(key: PropertyKey) {
		return this.properties.get(key)!;
	}

	set(key: PropertyKey, value: PropertyDescriptor) {
		this.properties.set(key, value);

		if (PropertyMap.isArrayIndexProperty(key)) {
			this.arrayIndexProperties.push(key);
		}
	}

	delete(key: PropertyKey) {
		this.properties.delete(key);

		if (
			PropertyMap.isArrayIndexProperty(key) &&
			this.arrayIndexProperties.includes(key)
		) {
			this.arrayIndexProperties.splice(this.arrayIndexProperties.indexOf(key), 1);
		}
	}

	ownPropertyKeys() {
		return [...this.properties.keys()];
	}

	arrayIndexPropertyKeys() {
		return [...this.arrayIndexProperties];
	}
}
