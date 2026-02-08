import { createBuiltinFunction } from "../abstract-operations/built-in-function-object.ts";
import { makeClassConstructor } from "../abstract-operations/function-objects.ts";
import {
	createArrayFromList,
	definePropertyOrThrow,
	get,
} from "../abstract-operations/object-operations.ts";
import {
	ordinaryCreateFromConstructor,
	ordinaryObjectCreate,
} from "../abstract-operations/ordinary-object.ts";
import { PropertyDescriptor } from "../abstract-operations/property-map.ts";
import { toObject, toPropertyKey } from "../abstract-operations/type-conversion.ts";
import type { Realm } from "../execution-contexts/realm.ts";
import {
	normalCompletion,
	throwCompletion,
} from "../types-and-values/completion-record.ts";
import { EngineValue } from "../types-and-values/data-types.ts";

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object-constructor
export function intrinsicObject(realm: Realm) {
	realm.intrinsics["%Object%"] = createBuiltinFunction(
		(_thisValue, argumentsList, newTarget) => {
			if (newTarget !== undefined) {
				return normalCompletion(
					ordinaryCreateFromConstructor(newTarget, "%Object.prototype%"),
				);
			}

			if (argumentsList[0]?.isNull() || argumentsList[0]?.isUndefined()) {
				return normalCompletion(
					ordinaryObjectCreate(realm.intrinsics["%Object.prototype%"]!.asObject()),
				);
			}

			return toObject(argumentsList[0]!);
		},
		1,
		"Object",
		[],
		realm,
	);

	makeClassConstructor(realm.intrinsics["%Object%"].asObject());

	const objectConstructor = realm.intrinsics["%Object%"].asObject();

	definePropertyOrThrow(
		objectConstructor,
		"prototype",
		new PropertyDescriptor({
			value: realm.intrinsics["%Object.prototype%"]!,
			writable: false,
			enumerable: false,
			configurable: false,
		}),
	);

	// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.create
	definePropertyOrThrow(
		objectConstructor,
		"create",
		new PropertyDescriptor({
			value: createBuiltinFunction(
				(_thisArgument, argumentsList) => {
					const O = argumentsList[0]!;
					const properties = argumentsList[1]!;

					if (!O || !O.isObject() || !O.isNull()) {
						return throwCompletion(
							new TypeError("First argument to Object.create must be an object."),
						);
					}

					const obj = ordinaryObjectCreate(O);

					if (properties) {
						const res = objectDefineProperties(obj, properties);
						if (res.type === "throw") {
							return res;
						}
					}

					return normalCompletion(obj);
				},
				2,
				"create",
				[],
				realm,
			),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	);

	// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.defineproperty
	definePropertyOrThrow(
		objectConstructor,
		"defineProperty",
		new PropertyDescriptor({
			value: createBuiltinFunction(
				(_thisArgument, argumentsList) => {
					const O = argumentsList[0];
					const P = argumentsList[1];
					const Desc = argumentsList[2];

					if (!O || !O.isObject()) {
						return throwCompletion(
							new TypeError("First argument to Object.defineProperty is not an object."),
						);
					}

					const key = toPropertyKey(P!);
					if (key.type === "throw") {
						return key;
					}

					const desc = PropertyDescriptor.toPropertyDescriptor(Desc!);
					if (desc.type === "throw") {
						return desc;
					}

					const res = definePropertyOrThrow(O, key.value, desc.value);
					if (res.type === "throw") {
						return res;
					}

					return normalCompletion(O);
				},
				3,
				"defineProperty",
				[],
				realm,
			),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	);

	// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.getownpropertydescriptor
	definePropertyOrThrow(
		objectConstructor,
		"getOwnPropertyDescriptor",
		new PropertyDescriptor({
			value: createBuiltinFunction(
				(_thisArgument, argumentsList) => {
					const O = argumentsList[0];
					const P = argumentsList[1];

					const obj = toObject(O!);
					if (obj.type === "throw") {
						return obj;
					}

					const key = toPropertyKey(P!);
					if (key.type === "throw") {
						return key;
					}

					const desc = obj.value.objectGetInternalSlot("GetOwnProperty")(
						obj.value,
						key.value,
					);
					if (desc.type === "throw") {
						return desc;
					}

					return normalCompletion(PropertyDescriptor.fromPropertyDescriptor(desc.value));
				},
				2,
				"getOwnPropertyDescriptor",
				[],
				realm,
			),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	);

	// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.getownpropertynames
	definePropertyOrThrow(
		objectConstructor,
		"getOwnPropertyNames",
		new PropertyDescriptor({
			value: createBuiltinFunction(
				(_thisArgument, argumentsList) => {
					const O = argumentsList[0];
					const keys = getOwnPropertyKeys(O!, "string");
					if (keys.type === "throw") {
						return keys;
					}

					return createArrayFromList(keys.value);
				},
				1,
				"getOwnPropertyNames",
				[],
				realm,
			),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	);

	// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.getownpropertysymbols
	definePropertyOrThrow(
		objectConstructor,
		"getOwnPropertySymbols",
		new PropertyDescriptor({
			value: createBuiltinFunction(
				(_thisArgument, argumentsList) => {
					const O = argumentsList[0];
					const keys = getOwnPropertyKeys(O!, "symbol");
					if (keys.type === "throw") {
						return keys;
					}

					return createArrayFromList(keys.value);
				},
				1,
				"getOwnPropertySymbols",
				[],
				realm,
			),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	);

	// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.getprototypeof
	definePropertyOrThrow(
		objectConstructor,
		"getPrototypeOf",
		new PropertyDescriptor({
			value: createBuiltinFunction(
				(_thisArgument, argumentsList) => {
					const obj = toObject(argumentsList[0]!);
					if (obj.type === "throw") {
						return obj;
					}

					return obj.value.objectGetInternalSlot("GetPrototypeOf")(obj.value);
				},
				1,
				"getPrototypeOf",
				[],
				realm,
			),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	);
}

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-objectdefineproperties
function objectDefineProperties(obj: EngineValue<"object">, properties: EngineValue) {
	const props = toObject(properties);
	if (props.type === "throw") {
		return props;
	}
	const keys = props.value.objectGetInternalSlot("OwnPropertyKeys")(props.value);
	if (keys.type === "throw") {
		return keys;
	}

	const descriptors = [];
	for (const nextKey of keys.value) {
		const propDesc = props.value.objectGetInternalSlot("GetOwnProperty")(
			props.value,
			nextKey,
		);
		if (propDesc.type === "throw") {
			return propDesc;
		}

		if (propDesc.value instanceof PropertyDescriptor && propDesc.value.enumerable) {
			const descObj = get(props.value, nextKey);
			if (descObj.type === "throw") {
				return descObj;
			}
			const desc = PropertyDescriptor.toPropertyDescriptor(descObj.value);
			if (desc.type === "throw") {
				return desc;
			}
			descriptors.push({ key: nextKey, descriptor: desc.value });
		}
	}

	for (const { key, descriptor } of descriptors) {
		const res = definePropertyOrThrow(obj, key, descriptor);
		if (res.type === "throw") {
			return res;
		}
	}

	return normalCompletion(obj);
}

// https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-getownpropertykeys
function getOwnPropertyKeys(O: EngineValue, type: "string" | "symbol") {
	const o = toObject(O);
	if (o.type === "throw") {
		return o;
	}

	const keys = o.value.objectGetInternalSlot("OwnPropertyKeys")(o.value);
	if (keys.type === "throw") {
		return keys;
	}

	return normalCompletion(
		keys.value
			.filter((key) => typeof key === type)
			.map((it) => (typeof it === "string" ? EngineValue.string(it) : it)),
	);
}
