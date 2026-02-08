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
import { EngineValue } from "../types-and-values/data-types.ts";

//tc39.es/ecma262/multipage/fundamental-objects.html#sec-error-constructor
export function intrinsicError(realm: Realm) {
	realm.intrinsics["%Error%"] = createBuiltinFunction(
		(_thisValue, argumentsList, newTarget) => {
			// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-error-message

			if (newTarget === undefined) {
				newTarget = getActiveFunctionObject();
			}

			const o = ordinaryCreateFromConstructor(newTarget, "%Error.prototype%", [
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
		"Error",
		[],
		realm,
	);

	makeClassConstructor(realm.intrinsics["%Error%"].asObject());

	const errorConstructor = realm.intrinsics["%Error%"].asObject();

	definePropertyOrThrow(
		errorConstructor,
		"prototype",
		new PropertyDescriptor({
			value: realm.intrinsics["%Error.prototype%"]!,
			writable: false,
			enumerable: false,
			configurable: false,
		}),
	);

	// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-error.iserror
	definePropertyOrThrow(
		errorConstructor,
		"isError",
		new PropertyDescriptor({
			value: createBuiltinFunction(
				(_thisArgument, argumentsList) => {
					const arg = argumentsList[0];
					if (!arg || !arg.isObject()) {
						return normalCompletion(EngineValue.boolean(false));
					}

					return normalCompletion(
						EngineValue.boolean(arg.objectHasInternalSlot("ErrorData")),
					);
				},
				1,
				"isError",
				[],
				realm,
			),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	);
}
