import { expect, test } from "maligator:test";

test("Node global fetch is available", () => {
	expect(typeof fetch).toBe("function");
});
