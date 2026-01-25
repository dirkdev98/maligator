import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { makeClassConstructor } from "../abstract-operations/function-objects.ts";
import { ordinaryCreateFromConstructor } from "../abstract-operations/ordinary-object.ts";
import { toBoolean } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-boolean-constructor
export function intrinsicBoolean(realm: Realm) {
	realm.intrinsics["%Boolean%"] = createBuiltinFunction(
		(_thisValue, argumentsList, newTarget) => {
			const b = toBoolean(argumentsList[0]!);

			if (newTarget === undefined) {
				return normalCompletion(b);
			}

			const o = ordinaryCreateFromConstructor(newTarget, "%Boolean.prototype%", [
				"BooleanData",
			]);
			o.objectSetInternalSlot("BooleanData", b.data.value);

			return normalCompletion(o);
		},
		1,
		"Boolean",
		[],
		realm,
	);

	makeClassConstructor(realm.intrinsics["%Boolean%"].asObject());
}
