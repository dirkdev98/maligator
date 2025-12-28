import { isNil } from "../../utils.ts";
import { EngineValue } from "../data-types.ts";

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
export type PropertyKey = string | EngineValue<"symbol">;

export class PropertyMap {
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
