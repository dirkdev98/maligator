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
					1,
					"at",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.charat
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
					1,
					"charAt",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.charcodeat
		definePropertyOrThrow(
			stringPrototype,
			"charCodeAt",
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
							return normalCompletion(EngineValue.number(NaN));
						}

						return normalCompletion(EngineValue.number(S.charCodeAt(position)));
					},
					1,
					"charCodeAt",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.codepointat
		definePropertyOrThrow(
			stringPrototype,
			"codePointAt",
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
							return normalCompletion(EngineValue.undefined());
						}

						const res = S.codePointAt(position);
						return normalCompletion(
							res !== undefined ? EngineValue.number(res) : EngineValue.undefined(),
						);
					},
					1,
					"codePointAt",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.concat
		definePropertyOrThrow(
			stringPrototype,
			"concat",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, _argumentsList, _newTarget) => {
						const O = thisArgument ?? EngineValue.undefined();
						requireObjectCoercible(O).unwrap();
						const S = toString(O).unwrap().data.value;
						let R = S;

						for (const arg of _argumentsList) {
							const nextString = toString(arg).unwrap().data.value;
							R += nextString;
						}

						return normalCompletion(EngineValue.string(R));
					},
					1,
					"concat",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.endswith
		definePropertyOrThrow(
			stringPrototype,
			"endsWith",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, argumentsList, _newTarget) => {
						const O = thisArgument ?? EngineValue.undefined();
						requireObjectCoercible(O).unwrap();
						const S = toString(O).unwrap().data.value;

						// TODO: Regexp check.
						// 4. Let isRegExp be ? IsRegExp(searchString).
						// 5. If isRegExp is true, throw a TypeError exception.

						const searchString = toString(
							argumentsList[0] ?? EngineValue.undefined(),
						).unwrap();
						const len = S.length;

						const pos =
							argumentsList[1] === undefined || argumentsList[1].isUndefined()
								? len
								: toIntegerOrInfinity(argumentsList[1]).unwrap();

						const end = Math.max(0, Math.min(len, pos));
						const searchLength = searchString.data.value.length;
						if (searchLength === 0) {
							return normalCompletion(EngineValue.boolean(true));
						}

						const start = end - searchLength;
						if (start < 0) {
							return normalCompletion(EngineValue.boolean(false));
						}

						const substring = S.slice(start, end);
						return normalCompletion(
							EngineValue.boolean(substring === searchString.data.value),
						);
					},
					2,
					"endsWith",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.includes
		definePropertyOrThrow(
			stringPrototype,
			"includes",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, argumentsList, _newTarget) => {
						const O = thisArgument ?? EngineValue.undefined();
						requireObjectCoercible(O).unwrap();
						const S = toString(O).unwrap().data.value;

						// TODO: Regexp check.
						// 4. Let isRegExp be ? IsRegExp(searchString).
						// 5. If isRegExp is true, throw a TypeError exception.

						const searchString = toString(
							argumentsList[0] ?? EngineValue.undefined(),
						).unwrap();
						const len = S.length;

						const pos =
							argumentsList[1] === undefined || argumentsList[1].isUndefined()
								? 0
								: toIntegerOrInfinity(argumentsList[1]).unwrap();

						const start = Math.max(0, Math.min(len, pos));
						const index = EngineValue.string(S).stringIndexOf(searchString, start);

						if (index === -1) {
							return normalCompletion(EngineValue.boolean(false));
						}

						return normalCompletion(EngineValue.boolean(true));
					},
					2,
					"includes",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.indexof
		definePropertyOrThrow(
			stringPrototype,
			"indexOf",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, argumentsList, _newTarget) => {
						const O = thisArgument ?? EngineValue.undefined();
						requireObjectCoercible(O).unwrap();
						const S = toString(O).unwrap().data.value;

						// TODO: Regexp check.
						// 4. Let isRegExp be ? IsRegExp(searchString).
						// 5. If isRegExp is true, throw a TypeError exception.

						const searchString = toString(
							argumentsList[0] ?? EngineValue.undefined(),
						).unwrap();
						const len = S.length;

						const pos =
							argumentsList[1] === undefined || argumentsList[1].isUndefined()
								? 0
								: toIntegerOrInfinity(argumentsList[1]).unwrap();

						const start = Math.max(0, Math.min(len, pos));
						const index = EngineValue.string(S).stringIndexOf(searchString, start);

						return normalCompletion(EngineValue.number(index));
					},
					2,
					"indexOf",
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
