// Store-heavy micro: captured-slot (closure env) store.
//
// Exercises the card-barrier tax at the closure captured-slot store funnel
// (mal_vm_store_captured in vm_ops.c, carrying mal_gc_card on the env cell). The
// accumulator closure captures `sum`/`xor` in its defining env; each call writes
// those captured slots. The env is promoted to OLD via a forced collection, so
// each captured store hits the old-owner card path. The closure-call machinery is
// inherent per-op overhead, so this reports the barrier tax as a fraction of a
// realistic captured-store op. See object-prop.js for the timing rationale.

const gc = globalThis.__mal_collect_garbage;

function makeAccumulator() {
	let sum = 0;
	let xor = 0;
	return function step(i) {
		sum = (sum + i) & 0x3fffffff;
		xor = xor ^ i;
		return sum + xor;
	};
}

const step = makeAccumulator();

if (typeof gc === "function") {
	gc();
	gc();
}

const ITERS = 40000000;
let checksum = 0;
const start = Date.now();
for (let i = 0; i < ITERS; i++) {
	checksum = (checksum + step(i)) & 0x3fffffff;
}
const elapsed = Date.now() - start;
console.log("captured-slot ELAPSED " + elapsed + " CHK " + checksum);
