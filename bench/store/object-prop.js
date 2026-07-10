// Store-heavy micro: shaped-object property overwrite.
//
// Isolates the card-barrier tax at the object-slot store funnel
// (mal_vm_object_try_store / mal_vm_object_slot_store in vm_ops.h, carrying
// mal_gc_card). The owner object is allocated once and promoted to OLD (sticky
// BLACK) via a forced collection, then a hot loop overwrites its data slots with
// non-heap values only — no allocation, so nothing triggers a further collection
// and the loop is pure stores. Under a generational build every store executes
// the card barrier (owner is old); under a non-generational build the barrier
// folds to nothing. The wall delta between the two is the pure per-store tax.
//
// Timed in-process (Date.now around the hot loop) so process startup does not
// dilute the ratio. Prints: "<name> ELAPSED <ms> CHK <checksum>".

const gc = globalThis.__mal_collect_garbage;

const o = { a: 1, b: 2, c: 3, d: 4 };

// Promote `o` to the old generation: it survives the forced collection and keeps
// its sticky BLACK mark, so every subsequent slot store hits the old-owner card
// path (the realistic steady state for a long-lived mutated object).
if (typeof gc === "function") {
	gc();
	gc();
}

const ITERS = 60000000;
let checksum = 0;
const start = Date.now();
for (let i = 0; i < ITERS; i++) {
	o.a = i;
	o.b = i + 1;
	o.c = o.a + o.b;
	o.d = i & 255;
	checksum = (checksum + o.c + o.d) & 0x3fffffff;
}
const elapsed = Date.now() - start;
console.log("object-prop ELAPSED " + elapsed + " CHK " + checksum);
