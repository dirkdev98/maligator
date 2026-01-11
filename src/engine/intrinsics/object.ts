import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import type { Realm } from "../execution-contexts/realm.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object-constructor
export function intrinsicObject(realm: Realm) {
	// TODO: Use %Function.prototype%
	realm.intrinsics["%Object%"] = ordinaryObjectCreate(
		realm.intrinsics["%Object.prototype%"]!.asObject(),
	);
}
