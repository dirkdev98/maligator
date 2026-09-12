import { deepStrictEqual, equal, notEqual } from "node:assert";
import { describe, it } from "vitest";
import {
	StaticDescriptionInterner,
	staticNumberDescription,
} from "../src/compiler/shared/static-values.ts";

describe("Static number description bit scratch", () => {
	it("preserves exact special-value and finite-value encodings", () => {
		const reference = new DataView(new ArrayBuffer(8));
		const values = [
			0,
			-0,
			NaN,
			Infinity,
			-Infinity,
			Number.MIN_VALUE,
			Number.MAX_VALUE,
			1 / 3,
		];
		for (const value of values) {
			reference.setFloat64(0, value, true);
			deepStrictEqual(staticNumberDescription(value), {
				kind: "number",
				low: reference.getUint32(0, true),
				high: reference.getUint32(4, true),
			});
		}
	});

	it("does not alias descriptions retained across subsequent calls", () => {
		const first = staticNumberDescription(-0);
		for (let value = 0; value < 1000; value++) staticNumberDescription(value / 7);
		deepStrictEqual(first, { kind: "number", low: 0, high: 0x80000000 });
	});

	it("keeps signed zeros distinct and interning stable across reused scratch", () => {
		const interner = new StaticDescriptionInterner();
		const positive = interner.intern(staticNumberDescription(0));
		const negative = interner.intern(staticNumberDescription(-0));
		notEqual(positive, negative);
		interner.intern(staticNumberDescription(Infinity));
		equal(interner.intern(staticNumberDescription(-0)), negative);
		deepStrictEqual(interner.description(positive), { kind: "number", low: 0, high: 0 });
	});
});
