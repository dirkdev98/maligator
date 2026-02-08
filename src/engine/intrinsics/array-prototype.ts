import {
	ArrayExoticMethods,
	arraySpeciesCreate,
} from "../abstract-operations/array-exotic.ts";
import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import {
	call,
	createDataPropertyOrThrow,
	definePropertyOrThrow,
	get,
	hasProperty,
	lengthOfArrayLike,
	makeBasicObject,
	set,
} from "../abstract-operations/object-operations.ts";
import { OrdinaryObjectInternalMethods } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { isCallable } from "../abstract-operations/testing-and-comparison.ts";
import { toObject, toString } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import {
	normalCompletion,
	throwCompletion,
	unwrapCompletion,
} from "../types-and-values/completion-record.ts";
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

		// https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.prototype.foreach
		definePropertyOrThrow(
			arrayPrototype,
			"forEach",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, argumentsList, _newTarget) => {
						const o = toObject(thisArgument!);
						if (o.type === "throw") {
							return o;
						}

						const len = lengthOfArrayLike(o.value);
						if (len.type === "throw") {
							return len;
						}

						const callbackfn = argumentsList[0]!;
						const thisArg = argumentsList[1] ?? EngineValue.undefined();

						if (!isCallable(callbackfn).data.value) {
							return throwCompletion(
								new TypeError("Array.prototype.map: callbackfn is not callable"),
							);
						}

						let k = 0;

						while (k < len.value) {
							const kPresent = hasProperty(o.value, `${k}`);
							if (kPresent.type === "throw") {
								return kPresent;
							}

							if (kPresent.value.data.value) {
								const kValue = get(o.value, `${k}`);
								if (kValue.type === "throw") {
									return kValue;
								}

								const callResult = call(callbackfn.asObject(), thisArg, [
									kValue.value,
									EngineValue.number(k),
									o.value,
								]);
								if (callResult.type === "throw") {
									return callResult;
								}
							}

							k++;
						}

						return normalCompletion(EngineValue.undefined());
					},
					2,
					"forEach",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.prototype.join
		definePropertyOrThrow(
			arrayPrototype,
			"join",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, argumentsList, _newTarget) => {
						const o = toObject(thisArgument!);
						if (o.type === "throw") {
							return o;
						}

						const len = lengthOfArrayLike(o.value);
						if (len.type === "throw") {
							return len;
						}

						let seperator = argumentsList[0];
						if (!seperator || seperator.isUndefined()) {
							seperator = EngineValue.string(",");
						} else {
							seperator = unwrapCompletion(toString(seperator));
						}

						let r = "";
						let k = 0;
						while (k < len.value) {
							if (k > 0) {
								r += seperator.asString().data.value;
							}

							const element = get(o.value, `${k}`);
							if (element.type === "throw") {
								return element;
							}

							if (element.value.isUndefined() || element.value.isNull()) {
								++k;
								continue;
							}

							const s = toString(element.value);
							if (s.type === "throw") {
								return s;
							}

							r += s.value.asString().data.value;

							++k;
						}

						return normalCompletion(EngineValue.string(r));
					},
					1,
					"join",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.prototype.map
		definePropertyOrThrow(
			arrayPrototype,
			"map",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, argumentsList, _newTarget) => {
						const o = toObject(thisArgument!);
						if (o.type === "throw") {
							return o;
						}

						const len = lengthOfArrayLike(o.value);
						if (len.type === "throw") {
							return len;
						}

						const callbackfn = argumentsList[0]!;
						const thisArg = argumentsList[1] ?? EngineValue.undefined();

						if (!isCallable(callbackfn).data.value) {
							return throwCompletion(
								new TypeError("Array.prototype.map: callbackfn is not callable"),
							);
						}

						const A = arraySpeciesCreate(o.value, len.value);
						let k = 0;

						while (k < len.value) {
							const kPresent = hasProperty(o.value, `${k}`);
							if (kPresent.type === "throw") {
								return kPresent;
							}
							if (kPresent.value.data.value) {
								const kValue = get(o.value, `${k}`);
								if (kValue.type === "throw") {
									return kValue;
								}

								const mappedValue = call(callbackfn.asObject(), thisArg, [
									kValue.value,
									EngineValue.number(k),
									o.value,
								]);
								createDataPropertyOrThrow(
									A.value!,
									`${k}`,
									mappedValue.value ?? EngineValue.undefined(),
								);
							}

							k++;
						}

						return A;
					},
					2,
					"map",
					[],
					realm,
				),
				writable: true,
				enumerable: false,
				configurable: true,
			}),
		);

		// https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.prototype.push
		definePropertyOrThrow(
			arrayPrototype,
			"push",
			new PropertyDescriptor({
				value: createBuiltinFunction(
					(thisArgument, argumentsList, _newTarget) => {
						const o = toObject(thisArgument!);
						if (o.type === "throw") {
							return o;
						}

						const len = lengthOfArrayLike(o.value);
						if (len.type === "throw") {
							return len;
						}

						const argCount = argumentsList.length;
						if (len.value + argCount > Math.pow(2, 53) - 1) {
							return throwCompletion(
								new TypeError("Array.prototype.push: length overflow"),
							);
						}

						for (const e of argumentsList) {
							set(o.value, `${len.value}`, e, true);
							len.value += 1;
						}

						set(o.value, "length", EngineValue.number(len.value), true);

						return normalCompletion(EngineValue.number(len.value));
					},
					1,
					"push",
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
