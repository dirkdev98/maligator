import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { makeClassConstructor } from "../abstract-operations/function-objects.ts";
import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { getPrototypeFromConstructor } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { stringCreate } from "../abstract-operations/string-exotic.ts";
import { toString } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import { symbolDescriptiveString } from "./symbol-prototype.ts";

// https://tc39.es/ecma262/multipage/text-processing.html#sec-string-constructor
export function intrinsicString(realm: Realm) {
	realm.intrinsics["%String%"] = createBuiltinFunction(
		(_thisValue, argumentsList, newTarget) => {
			// https://tc39.es/ecma262/multipage/text-processing.html#sec-string-constructor-string-value
			let input = argumentsList[0];

			if (!input) {
				input = EngineValue.string("");
			} else {
				if ((newTarget === undefined || newTarget.isUndefined()) && input.isSymbol()) {
					return normalCompletion(symbolDescriptiveString(input));
				}

				input = toString(input).unwrap();
			}

			if (newTarget === undefined || newTarget.isUndefined()) {
				return normalCompletion(input);
			}

			return normalCompletion(
				stringCreate(
					input.asString(),
					getPrototypeFromConstructor(newTarget, "%String.prototype%").unwrap(),
				),
			);
		},
		1,
		"String",
		[],
		realm,
	);

	makeClassConstructor(realm.intrinsics["%String%"].asObject());

	const stringConstructor = realm.intrinsics["%String%"].asObject();

	definePropertyOrThrow(
		stringConstructor,
		"prototype",
		new PropertyDescriptor({
			value: realm.intrinsics["%String.prototype%"]!,
			writable: false,
			enumerable: false,
			configurable: false,
		}),
	);
}
