import assert from "node:assert";
import { isDeepStrictEqual } from "node:util";

const loose = (a, b) => {
	try {
		assert.deepEqual(a, b);
		return true;
	} catch {
		return false;
	}
};
const partial = (a, b) => {
	try {
		assert.partialDeepStrictEqual(a, b);
		return true;
	} catch {
		return false;
	}
};
class Point {
	constructor(x) {
		this.x = x;
	}
}
const symbol = Symbol("s");
const cyclicA = { name: "a" };
cyclicA.self = cyclicA;
const cyclicB = { name: "a" };
cyclicB.self = cyclicB;
const errorA = new Error("boom");
const errorB = new Error("boom");
errorB.stack = "different";
const regexpA = /x/g;
const regexpB = /x/g;
regexpB.lastIndex = 2;
const cases = [
	["identical primitives", 1, 1],
	["zero and negative zero", 0, -0],
	["NaN", NaN, NaN],
	["number and string", 1, "1"],
	["null and undefined", null, undefined],
	["plain objects", { a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }],
	["different values", { a: 1 }, { a: 2 }],
	["missing key", { a: 1 }, { a: 1, b: undefined }],
	["prototype", new Point(1), { x: 1 }],
	["class instances", new Point(1), new Point(1)],
	["symbol keys", { [symbol]: 1 }, { [symbol]: 2 }],
	["holes", [1, , 3], [1, undefined, 3]],
	["array extras", Object.assign([1], { k: 1 }), [1]],
	[
		"maps",
		new Map([
			[1, { a: 1 }],
			[{ k: 1 }, "v"],
		]),
		new Map([
			[{ k: 1 }, "v"],
			[1, { a: 1 }],
		]),
	],
	["map values differ", new Map([[1, 1]]), new Map([[1, "1"]])],
	["sets", new Set([1, { a: 1 }]), new Set([{ a: 1 }, 1])],
	["sets loose primitives", new Set([1]), new Set(["1"])],
	["dates", new Date(0), new Date(0)],
	["dates differ", new Date(0), new Date(1)],
	["regexps lastIndex", regexpA, regexpB],
	["regexps flags", /x/g, /x/i],
	["boxed", new Number(1), new Number(1)],
	["boxed differ", new String("a"), new String("b")],
	["errors ignore stack", errorA, errorB],
	["errors differ", new Error("a"), new TypeError("a")],
	["typed arrays", new Uint8Array([1, 2]), new Uint8Array([1, 2])],
	["typed array kinds", new Uint8Array([1]), new Int8Array([1])],
	["float zero", new Float64Array([0]), new Float64Array([-0])],
	["array buffers", new Uint8Array([1, 2]).buffer, new Uint8Array([1, 2]).buffer],
	["cycles", cyclicA, cyclicB],
	["array vs object", [1], { 0: 1 }],
	["functions", () => {}, () => {}],
];
for (const [name, a, b] of cases) {
	console.log(name, isDeepStrictEqual(a, b), loose(a, b));
}
console.log("partial object", partial({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } }));
console.log("partial mismatch", partial({ a: 1 }, { a: 2 }));
console.log("partial array", partial([1, 2, 3], [1, 3]));
console.log("partial set", partial(new Set([1, 2, 3]), new Set([2])));
