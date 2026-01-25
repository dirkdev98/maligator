import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { makeClassConstructor } from "../abstract-operations/function-objects.ts";
import { toBigint } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";

// https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-bigint-constructor
export function intrinsicBigInt(realm: Realm) {
	realm.intrinsics["%BigInt%"] = createBuiltinFunction(
		(_thisValue, argumentsList, _newTarget) => {
			const n = toBigint(argumentsList[0]!);
			return n;
		},
		1,
		"BigInt",
		[],
		realm,
	);

	makeClassConstructor(realm.intrinsics["%BigInt%"].asObject());
}
