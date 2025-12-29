import { expect, test } from "vitest";
import { EngineValue } from "../data-types.ts";
import { isArrayExoticObject } from "./array-exotic.ts";
import { OrdinaryObjectInternalMethods } from "./ordinary-object.ts";

test("isArrayExoticObject returns false for object with OrdinaryObjectInternalMethods.DefineOwnProperty", () => {
	const obj = EngineValue.object([]);
	obj.objectSetInternalSlot(
		"DefineOwnProperty",
		OrdinaryObjectInternalMethods.DefineOwnProperty,
	);

	expect(isArrayExoticObject(obj)).toBe(false);
});

test("isArrayExoticObject returns false for object without DefineOwnProperty internal slot", () => {
	const obj = EngineValue.object([]);

	expect(isArrayExoticObject(obj)).toBe(false);
});
