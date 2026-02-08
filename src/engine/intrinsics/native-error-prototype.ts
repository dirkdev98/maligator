import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { NATIVE_ERROR } from "./navite-error.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-properties-of-the-nativeerror-prototype-objects
export function intrinsicNativeErrorPrototype(realm: Realm) {
	for (const name of NATIVE_ERROR) {
		const errorPrototype = ordinaryObjectCreate(
			realm.intrinsics["%Object.prototype%"]!.asObject(),
		);

		realm.intrinsics[`%${name}.prototype%`] = errorPrototype;
	}

	return () => {
		for (const name of NATIVE_ERROR) {
			const errPrototype = realm.intrinsics[`%${name}.prototype%`]!.asObject();

			// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-properties-of-the-nativeerror-prototype-objects
			definePropertyOrThrow(
				errPrototype,
				"constructor",
				new PropertyDescriptor({
					value: realm.intrinsics[`%${name}%`]!,
					writable: true,
					enumerable: false,
					configurable: true,
				}),
			);
		}
	};
}
