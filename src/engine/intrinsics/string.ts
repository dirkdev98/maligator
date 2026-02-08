import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { makeClassConstructor } from "../abstract-operations/function-objects.ts";
import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryCreateFromConstructor } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { toString } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";

// https://tc39.es/ecma262/multipage/text-processing.html#sec-string-constructor
export function intrinsicString(realm: Realm) {
	realm.intrinsics["%String%"] = createBuiltinFunction(
		(_thisValue, argumentsList, newTarget) => {
			const b = toString(argumentsList[0]!);

			if (newTarget === undefined || b.type === "throw") {
				return b;
			}

			const o = ordinaryCreateFromConstructor(newTarget, "%String.prototype%", [
				"StringData",
			]);
			o.objectSetInternalSlot("StringData", b.value.data.value);

			return normalCompletion(o);
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
