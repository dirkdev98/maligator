import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { ImmutablePrototypeExoticMethods } from "../abstract-operations/immutable-prototype-exotic.ts";
import {
	definePropertyOrThrow,
	get,
	makeBasicObject,
} from "../abstract-operations/object-operations.ts";
import { OrdinaryObjectInternalMethods } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { isArray } from "../abstract-operations/testing-and-comparison.ts";
import { toObject } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import {
	normalCompletion,
	unwrapCompletion,
} from "../types-and-values/completion-record.ts";
import { EngineValue, WELL_KNOWN_SYMBOLS } from "../types-and-values/data-types.ts";
import type { ObjectInternalSlots } from "../types-and-values/data-types.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-properties-of-the-object-prototype-object
export function intrinsicObjectPrototype(realm: Realm) {
	const objectPrototype = makeBasicObject(["Prototype", "Extensible"]);

	objectPrototype.objectSetInternalSlot("Extensible", true);
	objectPrototype.objectSetInternalSlot("Prototype", EngineValue.null());

	for (const [key, value] of Object.entries(OrdinaryObjectInternalMethods)) {
		objectPrototype.objectSetInternalSlot(key as keyof ObjectInternalSlots, value);
	}
	objectPrototype.objectSetInternalSlot(
		"SetPrototypeOf",
		ImmutablePrototypeExoticMethods.SetPrototypeOf,
	);

	realm.intrinsics["%Object.prototype%"] = objectPrototype;

	return () => {
		// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.prototype.constructor
		definePropertyOrThrow(
			objectPrototype,
			"constructor",
			new PropertyDescriptor({
				value: realm.intrinsics["%Object%"]!,
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.prototype.tostring
		definePropertyOrThrow(
			objectPrototype,
			"toString",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(_thisArgument, _argumentsList) => {
						if (!_thisArgument || _thisArgument.isUndefined()) {
							return normalCompletion(EngineValue.string("[object Undefined]"));
						}

						if (_thisArgument.isNull()) {
							return normalCompletion(EngineValue.string("[object Null]"));
						}

						const O = unwrapCompletion(toObject(_thisArgument));
						const isArr = unwrapCompletion(isArray(O));

						let computedTag = "Object";

						if (isArr.data.value) {
							computedTag = "Array";
						} else if (O.objectHasInternalSlot("ParameterMap")) {
							computedTag = "Arguments";
						} else if (O.objectHasInternalSlot("Call")) {
							computedTag = "Function";
						} else if (O.objectHasInternalSlot("ErrorData")) {
							computedTag = "Error";
						} else if (O.objectHasInternalSlot("BooleanData")) {
							computedTag = "Boolean";
						} else if (O.objectHasInternalSlot("NumberData")) {
							computedTag = "Number";
						} else if (O.objectHasInternalSlot("StringData")) {
							computedTag = "String";
						} else if (O.objectHasInternalSlot("DateValue")) {
							computedTag = "Date";
						} else if (O.objectHasInternalSlot("RegExpMatcher")) {
							computedTag = "RegExp";
						}

						const tag = get(O, WELL_KNOWN_SYMBOLS["%Symbol.toStringTag%"]);
						if (tag.type === "throw") {
							return tag;
						}
						if (tag.value.isString()) {
							computedTag = tag.value.data.value;
						}

						return normalCompletion(EngineValue.string(`[object ${computedTag}]`));
					},

					0,
					"toString",
					[],
					realm,
				),
			}),
		);
	};
}
