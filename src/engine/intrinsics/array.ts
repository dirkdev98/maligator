import { arrayCreate } from "../abstract-operations/array-exotic.ts";
import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { makeClassConstructor } from "../abstract-operations/function-objects.ts";
import {
	createDataPropertyOrThrow,
	definePropertyOrThrow,
	set,
} from "../abstract-operations/object-operations.ts";
import { getPrototypeFromConstructor } from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { isArray } from "../abstract-operations/testing-and-comparison.ts";
import { toUint32 } from "../abstract-operations/type-conversion.ts";
import { getActiveFunctionObject } from "../execution-contexts/execution-context.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import {
	normalCompletion,
	unwrapCompletion,
} from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";

// https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array-constructor
export function intrinsicArray(realm: Realm) {
	realm.intrinsics["%Array%"] = createBuiltinFunction(
		(_thisValue, argumentsList, newTarget) => {
			// https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array

			if (newTarget === undefined) {
				newTarget = getActiveFunctionObject();
			}

			const proto = getPrototypeFromConstructor(newTarget, "%Array.prototype%");
			if (proto.type === "throw") {
				return proto;
			}
			const numberOfArgs = argumentsList.length;

			if (numberOfArgs === 0) {
				return arrayCreate(0, proto.value);
			}

			if (numberOfArgs === 1) {
				let intLen = 0;

				const len = argumentsList[0]!;

				const array = arrayCreate(0, proto.value);
				if (array.type === "throw") {
					return array;
				}

				if (!len.isNumber()) {
					createDataPropertyOrThrow(array.value, "0", len);
					intLen = 1;
				} else {
					intLen = unwrapCompletion(toUint32(len)).asNumber().data.value;
				}

				set(array.value, "length", EngineValue.number(intLen), true);
				return array;
			}

			const array = arrayCreate(numberOfArgs, proto.value);
			if (array.type === "throw") {
				return array;
			}

			let k = 0;
			while (k < numberOfArgs) {
				const itemK = argumentsList[k]!;
				createDataPropertyOrThrow(array.value, `${k}`, itemK);

				++k;
			}

			return array;
		},
		1,
		"Array",
		[],
		realm,
	);

	makeClassConstructor(realm.intrinsics["%Array%"].asObject());

	const arrConstructor = realm.intrinsics["%Array%"].asObject();

	definePropertyOrThrow(
		arrConstructor,
		"prototype",
		new PropertyDescriptor({
			value: realm.intrinsics["%Array.prototype%"]!,
			writable: false,
			enumerable: false,
			configurable: false,
		}),
	);

	definePropertyOrThrow(
		arrConstructor,
		"isArray",
		new PropertyDescriptor({
			value: createBuiltinFunction(
				(_thisArgument, argumentsList) => {
					const arg = argumentsList[0];
					if (!arg) {
						return normalCompletion(EngineValue.boolean(false));
					}

					return isArray(arg);
				},
				1,
				"isArray",
				[],
				realm,
			),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	);
}
