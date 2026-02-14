import { normalCompletion } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import type { ObjectInternalSlots } from "../types-and-values/data-types.ts";
import { definePropertyOrThrow, makeBasicObject } from "./object-operations.ts";
import {
	isCompatiblePropertyDescriptor,
	ordinaryDefineOwnProperty,
	ordinaryGetOwnProperty,
} from "./ordinary-object.ts";
import type { PropertyKey } from "./property-map.ts";
import { PropertyMap } from "./property-map.ts";
import { PropertyDescriptor } from "./property-map.ts";
import { canonicalNumericIndexString } from "./type-conversion.ts";

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-string-exotic-objects
export const StringExoticMethods = {
	GetOwnProperty: (obj, P) => {
		const desc = ordinaryGetOwnProperty(obj, P);
		if (desc instanceof EngineValue) {
			return normalCompletion(stringGetOwnProperty(obj, P));
		}

		return normalCompletion(desc);
	},

	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-string-exotic-objects-defineownproperty-p-desc
	DefineOwnProperty: (obj, P, Desc) => {
		const stringDesc = stringGetOwnProperty(obj, P);
		if (stringDesc instanceof EngineValue) {
			return ordinaryDefineOwnProperty(obj, P, Desc);
		}

		const extensible = obj.objectGetInternalSlot("Extensible");
		return normalCompletion(isCompatiblePropertyDescriptor(extensible, Desc, stringDesc));
	},

	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-string-exotic-objects-ownpropertykeys
	OwnPropertyKeys: (obj) => {
		const str = obj.objectGetInternalSlot("StringData");
		const len = str.length;
		const keys = [];

		for (let i = 0; i < len; ++i) {
			keys.push(`${i}`);
		}

		for (const key of obj.data.properties.arrayIndexPropertyKeys()) {
			keys.push(key);
		}

		const symbolsToAdd = [];
		for (const key of obj.data.properties.ownPropertyKeys()) {
			if (key instanceof EngineValue) {
				symbolsToAdd.push(key);
				continue;
			}

			if (PropertyMap.isArrayIndexProperty(key)) {
				continue;
			}

			keys.push(key);
		}

		keys.push(...symbolsToAdd);

		return normalCompletion(keys);
	},
} satisfies Partial<ObjectInternalSlots>;

export function isStringExoticObject(obj: EngineValue<"object">): boolean {
	return (
		obj.objectGetInternalSlot("GetOwnProperty") === StringExoticMethods.GetOwnProperty
	);
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-stringcreate
export function stringCreate(
	value: EngineValue<"string">,
	prototype: EngineValue<"object">,
) {
	const S = makeBasicObject(["Prototype", "Extensible", "StringData"]);
	S.objectSetInternalSlot("Prototype", prototype);
	S.objectSetInternalSlot("StringData", value.data.value);
	S.objectSetInternalSlot("GetOwnProperty", StringExoticMethods.GetOwnProperty);
	S.objectSetInternalSlot("DefineOwnProperty", StringExoticMethods.DefineOwnProperty);
	S.objectSetInternalSlot("OwnPropertyKeys", StringExoticMethods.OwnPropertyKeys);

	const length = value.data.value.length;

	definePropertyOrThrow(
		S,
		"length",
		new PropertyDescriptor({
			value: EngineValue.number(length),
			writable: false,
			enumerable: false,
			configurable: false,
		}),
	).unwrap();

	return S;
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-stringgetownproperty
function stringGetOwnProperty(
	obj: EngineValue<"object">,
	P: PropertyKey,
): PropertyDescriptor | EngineValue<"undefined"> {
	if (typeof P !== "string") {
		return EngineValue.undefined();
	}

	const index = canonicalNumericIndexString(EngineValue.string(P));
	if (index.isUndefined()) {
		return EngineValue.undefined();
	}
	if (parseInt(String(index.asNumber().data.value)) !== index.asNumber().data.value) {
		return EngineValue.undefined();
	}
	if (index.asNumber().data.value < 0) {
		return EngineValue.undefined();
	}

	const str = obj.objectGetInternalSlot("StringData");

	const len = str.length;
	if (index.asNumber().data.value >= len) {
		return EngineValue.undefined();
	}

	return new PropertyDescriptor({
		value: EngineValue.string(str[index.asNumber().data.value] ?? ""),
		writable: false,
		enumerable: true,
		configurable: false,
	});
}
