// Store-heavy micro: Map value replacement.
//
// Exercises the card-barrier tax at the Map entry store funnel (map_object.c,
// carrying mal_gc_card for both key and value). A Map is populated once and
// promoted to OLD via a forced collection; the hot loop then replaces the value
// for existing keys with non-heap values. The hash lookup dominates each set(),
// so this reports the barrier tax as a fraction of a realistic Map-store op
// rather than an isolated store. See object-prop.js for the timing rationale.

const gc = globalThis.__mal_collect_garbage;

const KEYS = 256;
const m = new Map();
for (let i = 0; i < KEYS; i++) {
	m.set(i, 0);
}

if (typeof gc === "function") {
	gc();
	gc();
}

const OUTER = 40000;
let checksum = 0;
const start = Date.now();
for (let iter = 0; iter < OUTER; iter++) {
	for (let i = 0; i < KEYS; i++) {
		m.set(i, (m.get(i) + iter) & 0xffff);
		checksum = (checksum + m.get(i)) & 0x3fffffff;
	}
}
const elapsed = Date.now() - start;
console.log("map-value ELAPSED " + elapsed + " CHK " + checksum);
