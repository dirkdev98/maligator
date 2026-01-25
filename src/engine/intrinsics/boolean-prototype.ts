import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import type { Realm } from "../execution-contexts/realm.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-properties-of-the-boolean-prototype-object
export function intrinsicBooleanPrototype(realm: Realm) {
	const booleanPrototype = ordinaryObjectCreate(
		realm.intrinsics["%Object.prototype%"]!.asObject(),
		["BooleanData"],
	);

	realm.intrinsics["%Boolean.prototype%"] = booleanPrototype;

	booleanPrototype.objectSetInternalSlot("BooleanData", false);

	return () => {
		definePropertyOrThrow(
			booleanPrototype,
			"constructor",
			new PropertyDescriptor({
				value: realm.intrinsics["%Boolean%"]!,
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);
	};
}
