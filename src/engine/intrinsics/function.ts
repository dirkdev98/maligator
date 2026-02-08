import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { makeClassConstructor } from "../abstract-operations/function-objects.ts";
import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { throwCompletion } from "../types-and-values/completion-record.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-function-constructor
export function intrinsicFunction(realm: Realm) {
	realm.intrinsics["%Function%"] = createBuiltinFunction(
		(_thisValue, _argumentsList, _newTarget) => {
			// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-function-constructor
			return throwCompletion(new Error("Not yet implemented Function constructor."));
		},
		1,
		"Function",
		[],
		realm,
	);

	makeClassConstructor(realm.intrinsics["%Function%"].asObject());

	const functionConstructor = realm.intrinsics["%Function%"].asObject();

	definePropertyOrThrow(
		functionConstructor,
		"prototype",
		new PropertyDescriptor({
			value: realm.intrinsics["%Function.prototype%"]!,
			writable: false,
			enumerable: false,
			configurable: false,
		}),
	);
}
