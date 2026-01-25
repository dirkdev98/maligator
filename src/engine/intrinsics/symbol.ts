import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { makeClassConstructor } from "../abstract-operations/function-objects.ts";
import { toString } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import {
	normalCompletion,
	throwCompletion,
	unwrapCompletion,
} from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-symbol-constructor
export function intrinsicSymbol(realm: Realm) {
	realm.intrinsics["%Symbol%"] = createBuiltinFunction(
		(_thisValue, argumentsList, newTarget) => {
			const desc =
				argumentsList[0] ?
					unwrapCompletion(toString(argumentsList[0]))
				:	EngineValue.undefined();

			if (newTarget === undefined) {
				return normalCompletion(
					EngineValue.symbol(desc.isString() ? desc.data.value : undefined),
				);
			}

			return throwCompletion(new Error("Symbol is not a constructor."));
		},
		1,
		"Symbol",
		[],
		realm,
	);

	makeClassConstructor(realm.intrinsics["%Symbol%"].asObject());
}
