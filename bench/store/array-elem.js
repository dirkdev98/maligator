// Store-heavy micro: dense-array element overwrite.
//
// Isolates the card-barrier tax at the dense-array element store funnel
// (mal_array_object_store in array_object.c, carrying mal_gc_card). A dense array
// is filled once and promoted to OLD via a forced collection; the hot loop then
// overwrites existing elements with non-heap values only (no allocation, no
// length growth), so the loop is pure element stores hitting the old-owner card
// path. See object-prop.js for the timing/isolation rationale.

const gc = globalThis.__mal_collect_garbage;

const LEN = 1024;
const a = new Array(LEN);
for (let i = 0; i < LEN; i++) {
	a[i] = i;
}

if (typeof gc === "function") {
	gc();
	gc();
}

const OUTER = 60000;
let checksum = 0;
const start = Date.now();
for (let iter = 0; iter < OUTER; iter++) {
	for (let i = 0; i < LEN; i++) {
		a[i] = (a[i] + iter) & 0xffff;
		checksum = (checksum + a[i]) & 0x3fffffff;
	}
}
const elapsed = Date.now() - start;
console.log("array-elem ELAPSED " + elapsed + " CHK " + checksum);
