import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { makeClassConstructor } from "../abstract-operations/function-objects.ts";
import {
	createNonEnumerableDataPropertyOrThrow,
	definePropertyOrThrow,
} from "../abstract-operations/object-operations.ts";
import { ordinaryCreateFromConstructor } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { toString } from "../abstract-operations/type-conversion.ts";
import { getActiveFunctionObject } from "../execution-contexts/execution-context.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";

export const NATIVE_ERROR = [
	"EvalError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
];

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-nativeerror-object-structure
export function intrinsicNativeError(realm: Realm) {
	for (const name of NATIVE_ERROR) {
		realm.intrinsics[`%${name}%`] = createBuiltinFunction(
			(_thisValue, argumentsList, newTarget) => {
				// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-error-message

				if (newTarget === undefined) {
					newTarget = getActiveFunctionObject();
				}

				const o = ordinaryCreateFromConstructor(newTarget, `%${name}.prototype%`, [
					"ErrorData",
				]);
				o.objectSetInternalSlot("ErrorData", true);

				if (argumentsList[0] && !argumentsList[0].isUndefined()) {
					const msg = toString(argumentsList[0]);
					if (msg.type === "throw") {
						return msg;
					}
					createNonEnumerableDataPropertyOrThrow(o, "message", msg.value);
				}

				// TODO: Error.clause;

				return normalCompletion(o);
			},
			1,
			name,
			[],
			realm,
		);

		makeClassConstructor(realm.intrinsics[`%${name}%`]!.asObject());

		const errorConstructor = realm.intrinsics[`%${name}%`]!.asObject();

		definePropertyOrThrow(
			errorConstructor,
			"prototype",
			new PropertyDescriptor({
				value: realm.intrinsics[`%${name}.prototype%`]!,
				writable: false,
				enumerable: false,
				configurable: false,
			}),
		);
	}
}
