import { expect, test } from "maligator:test";

test.each([
	[1, 2, 3],
	[20, 22, 42],
])("adds row %#", (left, right, total) => {
	expect(left + right).toBe(total);
});

test.skip("reserved skipped case", () => {});
test.todo("reserved todo case");
