import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { EngineValue } from "../types-and-values/data-types.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-properties-of-the-symol-prototype-object
export function intrinsicSymbolPrototype(realm: Realm) {
	const symbolPrototype = ordinaryObjectCreate(
		realm.intrinsics["%Object.prototype%"]!.asObject(),
		["Description"],
	);

	realm.intrinsics["%Symbol.prototype%"] = symbolPrototype;

	return () => {
		definePropertyOrThrow(
			symbolPrototype,
			"constructor",
			new PropertyDescriptor({
				value: realm.intrinsics["%Symbol%"]!,
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);
	};
}

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-symboldescriptivestring
export function symbolDescriptiveString(symbol: EngineValue<"symbol">) {
	const desc = symbol.data.description ?? "";

	return EngineValue.string(`Symbol("${desc}")`);
}
