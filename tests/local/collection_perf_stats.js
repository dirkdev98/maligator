"use strict";

const objectKey = { key: "object" };
const symbolKey = Symbol("symbol");
const map = new Map([
	[1, 10],
	["string", 20],
	[symbolKey, 30],
	[objectKey, 40],
]);

map.set(1, 11);
map.delete("string");
let total = 0;
for (const [key, value] of map) {
	total += typeof key === "number" ? key + value : value;
}

const arrays = [
	[1, 2, 3],
	[1, 2.5, 3],
	[-0, Number.NaN],
];
arrays[0].push(objectKey);
for (const array of arrays) total += array.length;
for (const value of arrays[0]) {
	total += typeof value === "number" ? value : 0;
}

const retained = [];
for (let index = 0; index < 70_000; index++) retained.push([index]);
total += retained.length + retained[69_999][0];

const keyShapeMaps = [
	new Map([[1, 1]]),
	new Map([[1.5, 2]]),
	new Map([["key", 3]]),
	new Map([[objectKey, 4]]),
];
for (const shapedMap of keyShapeMaps) total += shapedMap.values().next().value;

if (total !== 140_106) throw new Error(`unexpected collection checksum: ${total}`);
const profiledSet = new Set([1, 2, 3, 4, 5, 6]);
profiledSet.has("query-only");
profiledSet.delete(null);
profiledSet.add(0.5).add(true);
const profiledStrings = new Set(["stored-string"]);
const profiledIdentity = new Set([objectKey]);
if (
	!profiledSet.has(0.5) ||
	!profiledStrings.has("stored-string") ||
	!profiledIdentity.has(objectKey)
) {
	throw new Error("Set profiling changed membership");
}
console.log("collection-perf-stats PASS 1/1");
