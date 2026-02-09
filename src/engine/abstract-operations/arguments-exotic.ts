import { isNil } from "../../utils.ts";
import type { EnvironmentRecord } from "../execution-contexts/environment-record.ts";
import { getCurrentRealm } from "../execution-contexts/execution-context.ts";
import { normalCompletion } from "../types-and-values/completion-record.ts";
import { EngineValue, WELL_KNOWN_SYMBOLS } from "../types-and-values/data-types.ts";
import type { ObjectInternalSlots } from "../types-and-values/data-types.ts";
import { createBuiltinFunction } from "./built-in-function-object.ts";
import {
	createDataPropertyOrThrow,
	definePropertyOrThrow,
	get,
	hasOwnProperty,
	makeBasicObject,
	set,
} from "./object-operations.ts";
import {
	ordinaryDefineOwnProperty,
	ordinaryDelete,
	ordinaryGet,
	ordinaryGetOwnProperty,
	ordinaryObjectCreate,
	ordinarySet,
} from "./ordinary-object.ts";
import { PropertyDescriptor } from "./property-map.ts";
import type { PropertyKey } from "./property-map.ts";
import { sameValue } from "./testing-and-comparison.ts";

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-arguments-exotic-objects
export const ArgumentsExoticMethods = {
	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-arguments-exotic-objects-getownproperty-p
	GetOwnProperty: (obj: EngineValue<"object">, P: PropertyKey) => {
		const desc = ordinaryGetOwnProperty(obj, P);
		if (desc instanceof EngineValue) {
			return normalCompletion(EngineValue.undefined());
		}

		const map = obj.objectGetInternalSlot("ParameterMap").asObject();
		const isMapped = hasOwnProperty(map, P).unwrap().data.value;
		if (isMapped) {
			desc.value = get(map, P).unwrap();
		}

		return normalCompletion(desc);
	},

	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-arguments-exotic-objects-defineownproperty-p-desc
	DefineOwnProperty: (obj, P, Desc) => {
		const map = obj.objectGetInternalSlot("ParameterMap").asObject();
		const isMapped = hasOwnProperty(map, P).unwrap().data.value;
		let newArgDesc = Desc;
		if (isMapped && Desc.isDataDescriptor()) {
			if (isNil(Desc.value) && Desc.writable === false) {
				newArgDesc = Desc.copyDescriptor();
				newArgDesc.value = get(map, P).unwrap();
			}
		}

		const allowed = ordinaryDefineOwnProperty(obj, P, newArgDesc).unwrap().data.value;
		if (!allowed) {
			return normalCompletion(EngineValue.boolean(false));
		}

		if (isMapped) {
			if (Desc.isAccessorDescriptor()) {
				map.objectGetInternalSlot("Delete")(map, P).unwrap();
			} else {
				if (Desc.value) {
					set(map, P, Desc.value, false).unwrap();
				}
				if (Desc.writable === false) {
					map.objectGetInternalSlot("Delete")(map, P).unwrap();
				}
			}
		}

		return normalCompletion(EngineValue.boolean(true));
	},

	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-arguments-exotic-objects-get-p-receiver
	Get: (obj, P, Receiver) => {
		const map = obj.objectGetInternalSlot("ParameterMap").asObject();
		const isMapped = hasOwnProperty(map, P).unwrap().data.value;
		if (!isMapped) {
			return ordinaryGet(obj, P, Receiver);
		}

		return get(map, P);
	},

	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-arguments-exotic-objects-set-p-v-receiver
	Set: (obj, P, V, Receiver) => {
		let isMapped = sameValue(obj, Receiver);
		const map = obj.objectGetInternalSlot("ParameterMap").asObject();

		if (isMapped) {
			isMapped = hasOwnProperty(map, P).unwrap().data.value;
		}

		if (isMapped) {
			set(map, P, V, false).unwrap();
		}

		return ordinarySet(obj, P, V, Receiver);
	},

	// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-arguments-exotic-objects-delete-p
	Delete: (obj, P) => {
		const map = obj.objectGetInternalSlot("ParameterMap").asObject();
		const isMapped = hasOwnProperty(map, P).unwrap().data.value;

		const result = ordinaryDelete(obj, P).unwrap().data.value;

		if (result && isMapped) {
			map.objectGetInternalSlot("Delete")(map, P).unwrap();
		}

		return normalCompletion(EngineValue.boolean(result));
	},
} satisfies Partial<ObjectInternalSlots>;

export function isArgumentsExoticObject(obj: EngineValue<"object">): boolean {
	return (
		obj.objectGetInternalSlot("DefineOwnProperty") ===
		ArgumentsExoticMethods.DefineOwnProperty
	);
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-createunmappedargumentsobject
export function createUnmappedArgumentsObject(argumentsList: Array<EngineValue>) {
	const len = argumentsList.length;
	const obj = ordinaryObjectCreate(
		getCurrentRealm().intrinsics["%Object.prototype%"]!.asObject(),
		["ParameterMap"],
	);
	obj.objectSetInternalSlot("ParameterMap", EngineValue.undefined());

	definePropertyOrThrow(
		obj,
		"length",
		new PropertyDescriptor({
			value: EngineValue.number(len),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	).unwrap();

	let index = 0;

	while (index < len) {
		const val = argumentsList[index]!;
		createDataPropertyOrThrow(obj, `${index}`, val).unwrap();
		++index;
	}

	definePropertyOrThrow(
		obj,
		WELL_KNOWN_SYMBOLS["%Symbol.iterator%"],
		new PropertyDescriptor({
			value: get(
				getCurrentRealm().intrinsics["%Array.prototype%"]!.asObject(),
				"values",
			).unwrap(),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	);

	definePropertyOrThrow(
		obj,
		"callee",
		new PropertyDescriptor({
			get: getCurrentRealm().intrinsics["%TypeError%"]!.asObject(),
			set: getCurrentRealm().intrinsics["%TypeError%"]!.asObject(),
			enumerable: false,
			configurable: false,
		}),
	);

	return obj;
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-createmappedargumentsobject
export function createMappedArgumentsObject(
	func: EngineValue<"object">,
	formals: Array<string>,
	argumentsList: Array<EngineValue>,
	env: EnvironmentRecord,
) {
	const len = argumentsList.length;
	const obj = makeBasicObject(["Prototype", "Extensible", "ParameterMap"]);
	obj.objectSetInternalSlot(
		"Prototype",
		getCurrentRealm().intrinsics["%Object.prototype%"]!.asObject(),
	);

	obj.objectSetInternalSlot("GetOwnProperty", ArgumentsExoticMethods.GetOwnProperty);
	obj.objectSetInternalSlot(
		"DefineOwnProperty",
		ArgumentsExoticMethods.DefineOwnProperty,
	);
	obj.objectSetInternalSlot("Get", ArgumentsExoticMethods.Get);
	obj.objectSetInternalSlot("Set", ArgumentsExoticMethods.Set);
	obj.objectSetInternalSlot("Delete", ArgumentsExoticMethods.Delete);

	const map = ordinaryObjectCreate(EngineValue.null());

	obj.objectSetInternalSlot("ParameterMap", map);

	const parameterNames = formals;
	const numberOfParameters = parameterNames.length;

	definePropertyOrThrow(
		obj,
		"length",
		new PropertyDescriptor({
			value: EngineValue.number(len),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	).unwrap();

	let index = 0;

	while (index < len) {
		const val = argumentsList[index]!;
		createDataPropertyOrThrow(obj, `${index}`, val).unwrap();
		++index;
	}

	index = numberOfParameters - 1;
	const mappedNames: Array<string> = [];
	while (index >= 0) {
		const name = parameterNames[index];
		if (!name) {
			continue;
		}

		if (!mappedNames.includes(name)) {
			mappedNames.push(name);

			if (index < len) {
				map
					.objectGetInternalSlot("DefineOwnProperty")(
						map,
						`${index}`,
						new PropertyDescriptor({
							get: makeArgGetter(name, env),
							set: makeArgSetter(name, env),
							enumerable: false,
							configurable: true,
						}),
					)
					.unwrap();
			}
		}

		index--;
	}

	definePropertyOrThrow(
		obj,
		WELL_KNOWN_SYMBOLS["%Symbol.iterator%"],
		new PropertyDescriptor({
			value: get(
				getCurrentRealm().intrinsics["%Array.prototype%"]!.asObject(),
				"values",
			).unwrap(),
			writable: true,
			enumerable: false,
			configurable: true,
		}),
	);

	definePropertyOrThrow(
		obj,
		"callee",
		new PropertyDescriptor({
			get: getCurrentRealm().intrinsics["%TypeError%"]!.asObject(),
			set: getCurrentRealm().intrinsics["%TypeError%"]!.asObject(),
			enumerable: false,
			configurable: false,
		}),
	);

	return obj;
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-makearggetter
function makeArgGetter(name: string, env: EnvironmentRecord) {
	const getterClosure = () => normalCompletion(env.getBindingValue(name, false));

	return createBuiltinFunction(getterClosure, 0, "", []);
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-makeargsetter
function makeArgSetter(name: string, env: EnvironmentRecord) {
	const setterClosure = (_this: unknown, argumentsList: Array<EngineValue>) => {
		env.setMutableBinding(name, argumentsList[0] ?? EngineValue.undefined(), false);
		return normalCompletion(EngineValue.undefined());
	};

	return createBuiltinFunction(setterClosure, 1, "", []);
}
