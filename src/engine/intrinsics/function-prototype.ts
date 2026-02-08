import { boundFunctionCreate } from "../abstract-operations/bound-function-exotic.ts";
import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import {
	setFunctionLength,
	setFunctionName,
} from "../abstract-operations/function-objects.ts";
import {
	call,
	createListFromArrayLike,
	definePropertyOrThrow,
	get,
	hasOwnProperty,
} from "../abstract-operations/object-operations.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { isCallable } from "../abstract-operations/testing-and-comparison.ts";
import { toIntegerOrInfinity } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import {
	normalCompletion,
	throwCompletion,
} from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-properties-of-the-function-prototype-object
export function intrinsicFunctionPrototype(realm: Realm) {
	const functionPrototype = createBuiltinFunction(
		() => {
			return normalCompletion(EngineValue.undefined());
		},
		0,
		"",
		[],
		realm,
		EngineValue.null(),
	);
	realm.intrinsics["%Function.prototype%"] = functionPrototype;

	return () => {
		// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-function.prototype.apply
		definePropertyOrThrow(
			functionPrototype,
			"apply",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, argumentsList, _newTarget) => {
						const thisValue = thisArgument;

						if (!thisValue || !isCallable(thisValue).data.value) {
							return throwCompletion(
								new TypeError("Function.prototype.apply called on incompatible receiver"),
							);
						}

						const thisArg = argumentsList[0];
						const argArray = argumentsList[1];

						if (!argArray || argArray.isUndefined() || argArray.isNull()) {
							return call(thisValue.asObject(), thisArg!, []);
						}

						const argList = createListFromArrayLike(argArray);

						if (argList.type === "throw") {
							return argList;
						}

						return call(thisValue.asObject(), thisArg!, argList.value);
					},
					1,
					"apply",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-function.prototype.bind
		definePropertyOrThrow(
			functionPrototype,
			"bind",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, argumentsList, _newTarget) => {
						const target = thisArgument;

						if (!target || !isCallable(target).data.value) {
							return throwCompletion(
								new TypeError("Function.prototype.bind called on incompatible receiver"),
							);
						}

						const thisArg = argumentsList[0]!;
						const argArray = argumentsList.slice(1);

						const F = boundFunctionCreate(target.asObject(), thisArg, argArray);
						if (F.type === "throw") {
							return F;
						}

						let L = 0;

						const targetHasLength = hasOwnProperty(target.asObject(), "length");
						if (targetHasLength.type === "throw") {
							return targetHasLength;
						}

						if (targetHasLength.value.data.value) {
							const targetLen = get(target.asObject(), "length");

							if (targetLen.type === "throw") {
								return targetLen;
							}

							if (targetLen.value.isNumber()) {
								if (targetLen.value.data.value === +Infinity) {
									L = Infinity;
								} else if (targetLen.value.data.value === -Infinity) {
									L = 0;
								} else {
									const targetLenAsInt = toIntegerOrInfinity(targetLen.value);
									if (targetLenAsInt.type === "throw") {
										return targetLenAsInt;
									}
									L = Math.max(targetLenAsInt.value - argArray.length, 0);
								}
							}
						}

						setFunctionLength(F.value, L);
						const targetName = get(target.asObject(), "name");

						if (targetName.type === "throw") {
							return targetName;
						}

						if (!targetName.value.isString()) {
							targetName.value = EngineValue.string("");
						}

						setFunctionName(F.value, targetName.value.asString().data.value, "bound");

						return F;
					},
					1,
					"bind",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-function.prototype.call
		definePropertyOrThrow(
			functionPrototype,
			"call",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, argumentsList, _newTarget) => {
						const thisValue = thisArgument;

						if (!thisValue || !isCallable(thisValue).data.value) {
							return throwCompletion(
								new TypeError("Function.prototype.call called on incompatible receiver"),
							);
						}

						const thisArg = argumentsList[0]!;
						const argArray = argumentsList.slice(1);

						return call(thisValue.asObject(), thisArg, argArray);
					},
					1,
					"call",
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
