import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { EngineValue } from "../types-and-values/data-types.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-properties-of-the-function-prototype-object
export function intrinsicFunctionPrototype(realm: Realm) {
	const functionPrototype = ordinaryObjectCreate(EngineValue.null());
	realm.intrinsics["%Function.prototype%"] = functionPrototype;

	return () => {
		// TODO:
	};
}
