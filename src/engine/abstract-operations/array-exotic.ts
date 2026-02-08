import { isNil } from "../../utils.ts";
import { getCurrentRealm } from "../execution-contexts/execution-context.ts";
import {
	normalCompletion,
	throwCompletion,
} from "../types-and-values/completion-record.ts";
import type { CompletionRecord } from "../types-and-values/completion-record.ts";
import { EngineValue, WELL_KNOWN_SYMBOLS } from "../types-and-values/data-types.ts";
import type { ObjectInternalSlots } from "../types-and-values/data-types.ts";
import {
	construct,
	get,
	getFunctionRealm,
	makeBasicObject,
} from "./object-operations.ts";
import { ordinaryDefineOwnProperty, ordinaryGetOwnProperty } from "./ordinary-object.ts";
import { PropertyDescriptor, PropertyMap } from "./property-map.ts";
import type { PropertyKey } from "./property-map.ts";
import {
	isArray,
	isConstructor,
	sameValue,
	sameValueZero,
} from "./testing-and-comparison.ts";
import { toNumber, toUint32 } from "./type-conversion.ts";

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-array-exotic-objects
export const ArrayExoticMethods = {
	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-array-exotic-objects-defineownproperty-p-desc
	DefineOwnProperty: (
		obj: EngineValue<"object">,
		P: PropertyKey,
		Desc: PropertyDescriptor,
	) => {
		if (P === "length") {
			return arraySetLength(obj, Desc);
		}

		if (PropertyMap.isArrayIndexProperty(P)) {
			const lengthDesc = ordinaryGetOwnProperty(obj, "length");
			if (lengthDesc instanceof EngineValue) {
				throw new Error("'length' property should exist on array exotic object.");
			}

			const length = lengthDesc.value?.asNumber();
			const index = toUint32(EngineValue.string(P));

			if (index.type === "throw") {
				return index;
			}
			const indexValue = index.value.asNumber();

			if (
				indexValue.data.value >= (length?.data.value ?? 0) &&
				lengthDesc.writable === false
			) {
				return normalCompletion(EngineValue.boolean(false));
			}

			const succeeded = ordinaryDefineOwnProperty(obj, P, Desc);
			if (succeeded.type === "throw") {
				return succeeded;
			}
			if (!succeeded.value.data.value) {
				return succeeded;
			}

			if (indexValue.data.value > (length?.data.value ?? 0)) {
				lengthDesc.value = EngineValue.number(indexValue.data.value + 1);
				ordinaryDefineOwnProperty(obj, "length", lengthDesc);
			}

			return normalCompletion(EngineValue.boolean(true));
		}

		return ordinaryDefineOwnProperty(obj, P, Desc);
	},
} satisfies Partial<ObjectInternalSlots>;

export function isArrayExoticObject(obj: EngineValue<"object">): boolean {
	return (
		obj.objectGetInternalSlot("DefineOwnProperty") ===
		ArrayExoticMethods.DefineOwnProperty
	);
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-arraycreate
export function arrayCreate(length: number, proto?: EngineValue<"object">) {
	if (length > 2 ** 32 - 1) {
		return throwCompletion(
			new RangeError("Array length must be a finite integer <= 2^32 - 1."),
		);
	}

	proto ??= getCurrentRealm().intrinsics["%Array.prototype%"]!.asObject();

	const A = makeBasicObject(["Prototype", "Extensible"]);
	A.objectSetInternalSlot("Prototype", proto);
	A.objectSetInternalSlot("DefineOwnProperty", ArrayExoticMethods.DefineOwnProperty);
	ordinaryDefineOwnProperty(
		A,
		"length",
		new PropertyDescriptor({
			value: EngineValue.number(length),
			writable: true,
			enumerable: false,
			configurable: false,
		}),
	);

	return normalCompletion(A);
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-arrayspeciescreate
export function arraySpeciesCreate(originalArray: EngineValue<"object">, length: number) {
	const isArr = isArray(originalArray);
	if (isArr.type === "throw") {
		return isArr;
	}

	if (!isArr.value.data.value) {
		return arrayCreate(length);
	}

	const c = get(originalArray, "constructor");
	if (c.type === "throw") {
		return c;
	}
	let cVal = c.value;

	if (isConstructor(cVal).data.value) {
		const thisRealm = getCurrentRealm();
		const realmC = getFunctionRealm(cVal.asObject());
		if (thisRealm !== realmC) {
			if (sameValue(cVal, realmC.intrinsics["%Array%"]!)) {
				cVal = EngineValue.undefined();
			}
		}
	}

	if (cVal.isObject()) {
		const inter = get(cVal, WELL_KNOWN_SYMBOLS["%Symbol.species%"]);
		if (inter.type === "throw") {
			return inter;
		}
		cVal = inter.value;

		if (cVal.isNull()) {
			cVal = EngineValue.undefined();
		}
	}
	if (cVal.isUndefined()) {
		return arrayCreate(length);
	}

	if (!isConstructor(cVal).data.value) {
		return throwCompletion(
			new TypeError("Array.prototype.constructor must be a constructor."),
		);
	}

	return construct(cVal.asObject(), [EngineValue.number(length)]);
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-arraysetlength
export function arraySetLength(
	A: EngineValue<"object">,
	Desc: PropertyDescriptor,
): CompletionRecord<EngineValue<"boolean">> {
	if (isNil(Desc.value)) {
		return ordinaryDefineOwnProperty(A, "length", Desc);
	}

	const newLenDesc = Desc.copyDescriptor();
	const newLen = toUint32(Desc.value);
	if (newLen.type === "throw") {
		return newLen;
	}
	const numberLen = toNumber(Desc.value);
	if (numberLen.type === "throw") {
		return numberLen;
	}

	if (!sameValueZero(newLen.value, numberLen.value)) {
		return throwCompletion(new RangeError("Length must be a finite integer."));
	}

	newLenDesc.value = newLen.value;
	const oldLenDesc = ordinaryGetOwnProperty(A, "length");
	if (oldLenDesc instanceof EngineValue) {
		throw new Error("'length' property should exist on array exotic object.");
	}

	const oldLen = oldLenDesc.value!;

	if (newLenDesc.value.asNumber().data.value >= oldLen.asNumber().data.value) {
		return ordinaryDefineOwnProperty(A, "length", newLenDesc);
	}

	if (oldLenDesc.writable === false) {
		return normalCompletion(EngineValue.boolean(false));
	}

	let newWritable = newLenDesc.writable ?? true;
	if (!newWritable) {
		newLenDesc.writable = false;
	}

	const succeeded = ordinaryDefineOwnProperty(A, "length", newLenDesc);
	if (succeeded.type === "throw") {
		return succeeded;
	}

	if (!succeeded.value.data.value) {
		return succeeded;
	}

	for (const prop of A.data.properties.arrayIndexPropertyKeys()) {
		if (
			(toUint32(EngineValue.string(prop)).value?.data.value ?? 0) >=
			newLen.value.data.value
		) {
			const deleteSucceeded = A.objectGetInternalSlot("Delete")(A, prop);
			if (deleteSucceeded.type === "throw") {
				return deleteSucceeded;
			}

			if (!deleteSucceeded.value.data.value) {
				newWritable = false;
				newLenDesc.writable = false;
				ordinaryDefineOwnProperty(A, "length", newLenDesc);

				return deleteSucceeded;
			}
		}
	}

	if (!newWritable) {
		ordinaryDefineOwnProperty(
			A,
			"length",
			new PropertyDescriptor({
				writable: false,
			}),
		);
	}

	return normalCompletion(EngineValue.boolean(true));
}
