import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { EngineValue } from "../types-and-values/data-types.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-properties-of-the-object-prototype-object
export function intrinsicObjectPrototype(realm: Realm) {
	// TODO: Immutable prototype
	const objectPrototype = ordinaryObjectCreate(EngineValue.null());
	realm.intrinsics["%Object.prototype%"] = objectPrototype;

	return () => {
		// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.prototype.constructor
		definePropertyOrThrow(
			objectPrototype,
			"constructor",
			new PropertyDescriptor({
				value: realm.intrinsics["%Object%"]!,
				configurable: false,
				enumerable: false,
				writable: false,
			}),
		);
	};
}
