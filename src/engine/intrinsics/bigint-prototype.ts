import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import type { Realm } from "../execution-contexts/realm.ts";

// https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-properties-of-the-bigint-prototype-object
export function intrinsicBigIntPrototype(realm: Realm) {
	const bigIntPrototype = ordinaryObjectCreate(
		realm.intrinsics["%Object.prototype%"]!.asObject(),
		[],
	);

	realm.intrinsics["%BigInt.prototype%"] = bigIntPrototype;

	return () => {
		definePropertyOrThrow(
			bigIntPrototype,
			"constructor",
			new PropertyDescriptor({
				value: realm.intrinsics["%BigInt%"]!,
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);
	};
}
