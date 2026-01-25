import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import type { Realm } from "../execution-contexts/realm.ts";

// https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-properties-of-the-number-prototype-object
export function intrinsicNumberPrototype(realm: Realm) {
	const numberPrototype = ordinaryObjectCreate(
		realm.intrinsics["%Object.prototype%"]!.asObject(),
		["NumberData"],
	);

	realm.intrinsics["%Number.prototype%"] = numberPrototype;

	numberPrototype.objectSetInternalSlot("NumberData", 0);

	return () => {
		definePropertyOrThrow(
			numberPrototype,
			"constructor",
			new PropertyDescriptor({
				value: realm.intrinsics["%Number%"]!,
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);
	};
}
