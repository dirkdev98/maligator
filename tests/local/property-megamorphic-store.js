"use strict";

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

// The unreachable recursive edge keeps this as one real runtime property site
// in the compiled backend instead of cloning it into each caller.
function storeValue(object, value) {
	object.value = value;
	if (value === -1000) return storeValue(object, value + 1);
	return value;
}

const objects = [
	{ value: 0 },
	{ a: 1, value: 0 },
	{ b: 1, c: 2, value: 0 },
	{ d: 1, e: 2, f: 3, value: 0 },
	{ g: 1, h: 2, i: 3, j: 4, value: 0 },
	{ k: 1, l: 2, m: 3, n: 4, o: 5, value: 0 },
	{ p: 1, q: 2, r: 3, s: 4, t: 5, u: 6, value: 0 },
	{ v: 1, w: 2, x: 3, y: 4, z: 5, aa: 6, ab: 7, value: 0 },
	{ ac: 1, ad: 2, ae: 3, af: 4, ag: 5, ah: 6, ai: 7, aj: 8, value: 0 },
	{ ak: 1, al: 2, am: 3, an: 4, ao: 5, ap: 6, aq: 7, ar: 8, as: 9, value: 0 },
	{ at: 1, au: 2, av: 3, aw: 4, ax: 5, ay: 6, az: 7, ba: 8, bb: 9, bc: 10, value: 0 },
	{
		bd: 1,
		be: 2,
		bf: 3,
		bg: 4,
		bh: 5,
		bi: 6,
		bj: 7,
		bk: 8,
		bl: 9,
		bm: 10,
		bn: 11,
		value: 0,
	},
];

// Overflow the site's four inline ways and warm the shared shaped-property stub.
for (let i = 0; i < objects.length * 3; i++) {
	storeValue(objects[i % objects.length], i);
}

if (typeof globalThis.__mal_reset_perf_stats === "function") {
	globalThis.__mal_reset_perf_stats();
}

for (let i = 0; i < 240; i++) {
	const object = objects[i % objects.length];
	storeValue(object, i + 100);
	assert(object.value === i + 100, "megamorphic store value");
}

// Dictionary/accessor cases must miss the shaped stub and preserve full [[Set]].
let setterTotal = 0;
const accessor = {};
Object.defineProperty(accessor, "value", {
	set(value) {
		setterTotal += value;
	},
	configurable: true,
});
storeValue(accessor, 7);
assert(setterTotal === 7, "accessor store fallback");

const readOnly = {};
Object.defineProperty(readOnly, "value", {
	value: 11,
	writable: false,
	configurable: true,
});
let readOnlyThrew = false;
try {
	storeValue(readOnly, 12);
} catch (error) {
	readOnlyThrew = error instanceof TypeError;
}
assert(readOnlyThrew && readOnly.value === 11, "read-only store fallback");

delete objects[0].value;
storeValue(objects[0], 99);
assert(objects[0].value === 99, "dictionary migration store fallback");

console.log("property-megamorphic-store PASS");
