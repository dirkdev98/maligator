import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { makeClassConstructor } from "../abstract-operations/function-objects.ts";
import {
	ordinaryCreateFromConstructor,
	ordinaryObjectCreate,
} from "../abstract-operations/ordinary-object.ts";
import { toObject } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object-constructor
export function intrinsicObject(realm: Realm) {
	realm.intrinsics["%Object%"] = createBuiltinFunction(
		(_thisValue, argumentsList, newTarget) => {
			if (newTarget !== undefined) {
				return normalCompletion(
					ordinaryCreateFromConstructor(newTarget, "%Object.prototype%"),
				);
			}

			if (argumentsList[0]?.isNull() || argumentsList[0]?.isUndefined()) {
				return normalCompletion(
					ordinaryObjectCreate(realm.intrinsics["%Object.prototype%"]!.asObject()),
				);
			}

			return toObject(argumentsList[0]!);
		},
		1,
		"Object",
		[],
		realm,
	);

	makeClassConstructor(realm.intrinsics["%Object%"].asObject());
}
