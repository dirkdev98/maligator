import { expect, test } from "maligator:test";

test("Node global Headers is available", () => {
	expect(typeof Headers).toBe("function");
	expect(new Headers({ "x-test": "yes" }).get("x-test")).toBe("yes");
});
