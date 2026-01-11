import { EngineValue } from "../types-and-values/data-types.ts";
import { definePropertyOrThrow } from "./object-operations.ts";
import { PropertyDescriptor } from "./property-map.ts";
import type { PropertyKey } from "./property-map.ts";

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-setfunctionname
export function setFunctionName(
	F: EngineValue<"object">,
	name: PropertyKey,
	prefix?: string,
) {
	if (name instanceof EngineValue) {
		if (name.data.description) {
			name = `[${name.data.description}]`;
		} else {
			name = "";
		}
	}

	if (F.objectHasInternalSlot("InitialName")) {
		F.objectSetInternalSlot("InitialName", EngineValue.string(name));
	}

	if (prefix) {
		name = `${prefix} ${name}`;
	}

	definePropertyOrThrow(
		F,
		"name",
		new PropertyDescriptor({
			value: EngineValue.string(name),
			writable: false,
			enumerable: false,
			configurable: true,
		}),
	);
}

// https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-setfunctionlength
export function setFunctionLength(F: EngineValue<"object">, length: number) {
	definePropertyOrThrow(
		F,
		"length",
		new PropertyDescriptor({
			value: EngineValue.number(length),
			writable: false,
			enumerable: false,
			configurable: true,
		}),
	);
}
