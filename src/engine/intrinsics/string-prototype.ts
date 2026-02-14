import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { definePropertyOrThrow } from "../abstract-operations/object-operations.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { stringCreate } from "../abstract-operations/string-exotic.ts";
import { requireObjectCoercible } from "../abstract-operations/testing-and-comparison.ts";
import { toIntegerOrInfinity, toString } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import {
	normalCompletion,
	throwCompletion,
} from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";

// https://tc39.es/ecma262/multipage/text-processing.html#sec-properties-of-the-string-prototype-object
export function intrinsicStringPrototype(realm: Realm) {
	const stringPrototype = stringCreate(
		EngineValue.string(""),
		realm.intrinsics["%Object.prototype%"]!.asObject(),
	);

	realm.intrinsics["%String.prototype%"] = stringPrototype;

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

		// https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.at
		definePropertyOrThrow(
			stringPrototype,
			"at",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, _argumentsList, _newTarget) => {
						const O = thisArgument ?? EngineValue.undefined();
						requireObjectCoercible(O).unwrap();
						const S = toString(O).unwrap().data.value;

						const len = S.length;
						const relativeIndex = toIntegerOrInfinity(
							_argumentsList[0] ?? EngineValue.undefined(),
						).unwrap();

						const k = relativeIndex >= 0 ? relativeIndex : len + relativeIndex;
						if (k < 0 || k >= len) {
							return normalCompletion(EngineValue.undefined());
						}

						return normalCompletion(EngineValue.string(S[k] ?? ""));
					},
					0,
					"at",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.at
		definePropertyOrThrow(
			stringPrototype,
			"charAt",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, _argumentsList, _newTarget) => {
						const O = thisArgument ?? EngineValue.undefined();
						requireObjectCoercible(O).unwrap();
						const S = toString(O).unwrap().data.value;

						const size = S.length;
						const position = toIntegerOrInfinity(
							_argumentsList[0] ?? EngineValue.undefined(),
						).unwrap();

						if (position < 0 || position >= size) {
							return normalCompletion(EngineValue.string(""));
						}

						return normalCompletion(EngineValue.string(S[position] ?? ""));
					},
					0,
					"charAt",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.tostring
		definePropertyOrThrow(
			stringPrototype,
			"toString",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, _argumentsList, _newTarget) => {
						return normalCompletion(
							thisStringValue(thisArgument ?? EngineValue.undefined()),
						);
					},
					0,
					"toString",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		definePropertyOrThrow(
			stringPrototype,
			"valueOf",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, _argumentsList, _newTarget) => {
						return normalCompletion(
							thisStringValue(thisArgument ?? EngineValue.undefined()),
						);
					},
					0,
					"valueOf",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);
	};
}

// https://tc39.es/ecma262/multipage/text-processing.html#sec-thisstringvalue
function thisStringValue(S: EngineValue): EngineValue<"string"> {
	if (S.isString()) {
		return S;
	}

	if (S.isObject() && S.objectHasInternalSlot("StringData")) {
		return EngineValue.string(S.objectGetInternalSlot("StringData"));
	}

	throwCompletion(new TypeError("String value expected")).unwrap();

	throw new Error("Unreachable, the unwrap throws.");
}
