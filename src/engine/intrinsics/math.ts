import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { ordinaryObjectCreate } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { toNumber } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";

// https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-math-object
export function intrinsicMath(realm: Realm) {
	realm.intrinsics["%Math%"] = ordinaryObjectCreate(
		realm.intrinsics["%Object.prototype%"]!.asObject(),
		[],
	);

	const mathConstructor = realm.intrinsics["%Math%"].asObject();

	// https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-math.e
	definePropertyOrThrow(
		mathConstructor,
		"E",
		new PropertyDescriptor({
			value: EngineValue.number(Math.E),
			writable: false,
			enumerable: false,
			configurable: false,
		}),
	);

	// https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-math.pow
	definePropertyOrThrow(
		mathConstructor,
		"pow",
		new PropertyDescriptor({
			value: createBuiltinFunction(
				(_thisArgument, argumentsList) => {
					const base = toNumber(argumentsList[0]!);
					if (base.type === "throw") {
						return base;
					}
					const exponent = toNumber(argumentsList[1]!);
					if (exponent.type === "throw") {
						return exponent;
					}

					return normalCompletion(base.value.numberExponentiate(exponent.value));
				},
				2,
				"pow",
				[],
				realm,
			),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	);
}
