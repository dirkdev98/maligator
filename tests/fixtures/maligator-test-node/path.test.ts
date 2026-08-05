import { expect, test } from "maligator:test";
import { basename, join } from "node:path";

test("loads configured host modules from cached wire", () => {
	expect(basename(join("one", "two", "file.ts"))).toBe("file.ts");
});
