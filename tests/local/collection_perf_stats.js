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

if (total !== 97) throw new Error(`unexpected collection checksum: ${total}`);
console.log("collection-perf-stats PASS 1/1");
