"use strict";

const collect = globalThis.__mal_collect_garbage || globalThis.gc;
if (typeof collect !== "function")
	throw new Error("Map representative fixture requires GC");
let checks = 0;
function check(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	checks++;
}
function key(index) {
	return ["map-string-representative-", index, "-", "q".repeat(96), "\ud800\u00e9"].join(
		"",
	);
}

const originals = Array.from({ length: 192 }, (_, index) => key(index));
const map = new Map();
for (let index = 0; index < originals.length; index++) map.set(originals[index], index);
const iterator = map.entries();
const first = iterator.next().value;
check("initial iterator", first[0] === originals[0] && first[1] === 0);
collect();
for (let index = 0; index < originals.length; index++) {
	const fresh = key(index);
	check("fresh lookup", map.get(fresh) === index);
	check("set return", map.set(fresh, index + 1000) === map);
	check("old key lookup", map.get(originals[index]) === index + 1000);
	if ((index & 31) === 31) collect();
}
check("updates preserve size", map.size === originals.length);
let order = 1;
for (let next = iterator.next(); !next.done; next = iterator.next()) {
	check("iterator update order", next.value[0] === originals[order]);
	check("iterator update value", next.value[1] === order + 1000);
	order++;
}
check("iterator complete", order === originals.length);

const visits = [];
map.forEach((value, storedKey) => {
	visits.push(value);
	const index = value - 1000;
	map.set(key(index), value + 1);
	check("forEach old key", map.get(storedKey) === value + 1);
});
check("forEach once per entry", visits.length === originals.length);

const pinned = map.keys();
check("pinned first", pinned.next().value === originals[0]);
for (let index = 0; index < 160; index++)
	check("delete equal key", map.delete(key(index)));
collect();
for (let index = 0; index < 96; index++) map.set(key(index), index + 2000);
const remaining = Array.from(pinned);
check("delete and append order", remaining.length === 128);
check("remaining starts at first live", remaining[0] === originals[160]);
check("reinsert ends at last appended", remaining[127] === originals[95]);
const acrossClear = map.entries();
acrossClear.next();
map.clear();
check("cleared absent", map.get(originals[95]) === undefined && !map.has(key(95)));
map.set(key(95), 3000);
const afterClear = acrossClear.next();
check(
	"clear iterator observes new entry",
	!afterClear.done && afterClear.value[1] === 3000,
);
check("clear iterator finishes", acrossClear.next().done);
collect();
check("retained representative", map.get(originals[95]) === 3000);

const object = {};
const other = {};
const symbol = Symbol("key");
const numbers = new Map([
	[NaN, 1],
	[-0, 2],
	[object, 3],
	[symbol, 4],
	[1n, 5],
]);
numbers.set(Number("nan"), 11).set(0, 12).set(object, 13).set(symbol, 14).set(1n, 15);
collect();
check(
	"non-string domains",
	numbers.size === 5 && numbers.get(NaN) === 11 && numbers.get(-0) === 12,
);
check("object identity", numbers.get(object) === 13 && numbers.get(other) === undefined);
check("symbol and bigint", numbers.get(symbol) === 14 && numbers.get(1n) === 15);
check("canonical zero", 1 / Array.from(numbers.keys())[1] === Infinity);

const weak = new WeakMap([[object, 7]]);
weak.set(object, 8);
collect();
check("weak map control", weak.get(object) === 8);
console.log("map-string-representative PASS " + checks + "/" + checks);
