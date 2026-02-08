import { ArrayExoticMethods } from "../abstract-operations/array-exotic.ts";
import {
	definePropertyOrThrow,
	makeBasicObject,
} from "../abstract-operations/object-operations.ts";
import { OrdinaryObjectInternalMethods } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { EngineValue } from "../types-and-values/data-types.ts";
import type { ObjectInternalSlots } from "../types-and-values/data-types.ts";

// https://tc39.es/ecma262/multipage/indexed-collections.html#sec-properties-of-the-array-prototype-object
export function intrinsicArrayPrototype(realm: Realm) {
	const arrayPrototype = makeBasicObject(["Prototype", "Extensible"]);

	arrayPrototype.objectSetInternalSlot(
		"Prototype",
		realm.intrinsics["%Object.prototype%"]!.asObject(),
	);

	for (const [key, value] of Object.entries(OrdinaryObjectInternalMethods)) {
		arrayPrototype.objectSetInternalSlot(key as keyof ObjectInternalSlots, value);
	}

	arrayPrototype.objectSetInternalSlot(
		"DefineOwnProperty",
		ArrayExoticMethods.DefineOwnProperty,
	);
	arrayPrototype.data.properties.set(
		"length",
		new PropertyDescriptor({
			value: EngineValue.number(0),
			writable: true,
			configurable: false,
			enumerable: false,
		}),
	);

	realm.intrinsics["%Array.prototype%"] = arrayPrototype;

	return () => {
		// https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.prototype.constructor
		definePropertyOrThrow(
			arrayPrototype,
			"constructor",
			new PropertyDescriptor({
				value: realm.intrinsics["%Array%"]!,
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);
	};
}
