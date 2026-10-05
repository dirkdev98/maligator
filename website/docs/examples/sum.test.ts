import { describe, expect, test } from "maligator:test";
import { sum } from "./sum.ts";

describe("sum", () => {
	test("adds values", () => {
		expect(sum([1, 2, 3])).toBe(6);
	});
	test("accepts an empty input", () => {
		expect(sum([])).toBe(0);
	});
});
