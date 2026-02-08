import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { makeClassConstructor } from "../abstract-operations/function-objects.ts";
import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryCreateFromConstructor } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { toNumeric } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";

// https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number-constructor
export function intrinsicNumber(realm: Realm) {
	realm.intrinsics["%Number%"] = createBuiltinFunction(
		(_thisValue, argumentsList, newTarget) => {
			const n = toNumeric(argumentsList[0]!);
			if (n.type !== "normal") {
				return n;
			}

			if (newTarget === undefined) {
				return n;
			}

			const o = ordinaryCreateFromConstructor(newTarget, "%Number.prototype%", [
				"NumberData",
			]);
			o.objectSetInternalSlot("NumberData", Number(n.value.data.value));

			return normalCompletion(o);
		},
		1,
		"Number",
		[],
		realm,
	);

	makeClassConstructor(realm.intrinsics["%Number%"].asObject());

	const numberConstructor = realm.intrinsics["%Number%"].asObject();

	definePropertyOrThrow(
		numberConstructor,
		"prototype",
		new PropertyDescriptor({
			value: realm.intrinsics["%Number.prototype%"]!,
			writable: false,
			enumerable: false,
			configurable: false,
		}),
	);
}
