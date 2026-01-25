import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import type { Realm } from "../execution-contexts/realm.ts";

// https://tc39.es/ecma262/multipage/text-processing.html#sec-properties-of-the-string-prototype-object
export function intrinsicStringPrototype(realm: Realm) {
	const stringPrototype = ordinaryObjectCreate(
		realm.intrinsics["%Object.prototype%"]!.asObject(),
		["StringData"],
	);

	realm.intrinsics["%String.prototype%"] = stringPrototype;

	stringPrototype.objectSetInternalSlot("StringData", "");

	return () => {
		definePropertyOrThrow(
			stringPrototype,
			"constructor",
			new PropertyDescriptor({
				value: realm.intrinsics["%String%"]!,
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);
	};
}
