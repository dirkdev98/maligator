import { expect, test } from "vitest";
import { immediateDominatorParents } from "../src/emit-vm.ts";

test("native proof dominators handle diamonds, loops, and unreachable nodes", () => {
	expect(immediateDominatorParents([[1, 2], [3], [3], [1], []])).toEqual([
		0, 0, 0, 0, -1,
	]);
});

test("native proof dominators stay linear for a product-sized control-flow graph", () => {
	const count = 20_000;
	const successors = Array.from({ length: count }, (_, index) =>
		index + 1 < count ? [index + 1] : [],
	);
	const parents = immediateDominatorParents(successors);
	expect(parents).toHaveLength(count);
	expect(parents[0]).toBe(0);
	expect(parents[1]).toBe(0);
	expect(parents.at(-1)).toBe(count - 2);
});
