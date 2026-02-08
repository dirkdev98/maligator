import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import type { Realm } from "../execution-contexts/realm.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-properties-of-the-error-prototype-object
export function intrinsicErrorPrototype(realm: Realm) {
	const errorPrototype = ordinaryObjectCreate(
		realm.intrinsics["%Object.prototype%"]!.asObject(),
	);

	errorPrototype.objectSetInternalSlot(
		"Prototype",
		realm.intrinsics["%Object.prototype%"]!.asObject(),
	);

	realm.intrinsics["%Error.prototype%"] = errorPrototype;

	return () => {
		// https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.prototype.constructor
		definePropertyOrThrow(
			errorPrototype,
			"constructor",
			new PropertyDescriptor({
				value: realm.intrinsics["%Error%"]!,
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);
	};
}
