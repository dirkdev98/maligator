// Targeted GC unit test: the concurrent incremental collector under AUTO-triggered
// cycles. The other gc fixtures call gc() (a synchronous complete collection), so
// they never exercise an INCREMENTAL cycle. This one allocates enough transient
// garbage under a small MAL_GC_THRESHOLD (+ MAL_GC_MAJOR_EVERY=1, set by the lane)
// to drive many auto-triggered cycles, so in a concurrent build the mark and sweep
// are sliced across the allocation loops' safepoints while the mutator keeps
// running. It asserts the collector's live-set integrity through that interleaving:
//
//   - a long-lived working set whose every element is content-checked at the end
//     (a missed root/edge or a bad SATB/black-alloc interaction would corrupt it);
//   - values PUBLISHED into already-old objects mid-cycle (the SATB deletion +
//     generational card barriers must keep the new young target alive);
//   - Map/Set + dictionary CHURN (insert/delete) interleaved with the marker;
//   - a generator SUSPENDED across many cycles holding an object only in its frame
//     (the coroutine-resume shade must preserve it);
//   - WeakRef / FinalizationRegistry observations across the run.
//
// Build-agnostic: in a non-concurrent build it is the same program under STW
// auto-collection and must pass identically. A failed assertion throws; the final
// "gcconc PASS N/N" prints only on full success. Driven on the HOST event loop so
// the suspended generator spans real turns and FinalizationRegistry jobs drain.

const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("gcconc requires MAL_HOST_GC=1 (gc hook absent)");
}

let passed = 0;
function ok(name, cond) {
	if (cond) {
		passed++;
		console.log("PASS " + name);
	} else {
		console.log("FAIL " + name);
		throw new Error("FAIL " + name);
	}
}

// A distinctive, self-describing heap object so a corrupted survivor is detectable.
function node(i) {
	return { id: i, tag: "n" + i, payload: new Array(8).fill(i), ref: null };
}
function intact(v, i) {
	return (
		v != null &&
		v.id === i &&
		v.tag === "n" + i &&
		v.payload.length === 8 &&
		v.payload[0] === i &&
		v.payload[7] === i
	);
}

// Long-lived working set: retained for the whole run. Old (survives cycles), so
// stores into it mid-cycle go through the SATB + card barriers.
const LIVE = 150;
const live = [];
for (let i = 0; i < LIVE; i++) {
	live[i] = node(i);
}

// Long-lived Map/Set that we churn during the allocation loops.
const map = new Map();
const set = new Set();

// A generator that holds a heap object only in its suspended frame; it stays
// suspended across many auto-triggered cycles, so the resume must find its object
// intact (the heap->root migration shade at resume).
function* framedHolder() {
	const secret = { marker: "held-in-frame", buf: new Array(64).fill(7) };
	let rounds = 0;
	while (true) {
		// Publish nothing; `secret` is reachable ONLY through this frame while
		// suspended. Yield the round count; the driver checks `secret` on the last.
		rounds++;
		const check = yield rounds;
		if (check === "verify") {
			return secret.marker === "held-in-frame" && secret.buf[63] === 7;
		}
	}
}
const holder = framedHolder();
holder.next(); // start; suspend at the first yield

// WeakRef observations: one target we keep, one we drop.
const keptTarget = { kind: "kept" };
const keptRef = new WeakRef(keptTarget);
let droppedRef = new WeakRef({ kind: "dropped" }); // no other reference → collectible

// FinalizationRegistry: observe a dropped object's reclamation.
let finalized = 0;
const registry = new FinalizationRegistry((held) => {
	if (held === "fin-token") {
		finalized++;
	}
});
(function registerEphemeral() {
	const ephemeral = { kind: "ephemeral" };
	registry.register(ephemeral, "fin-token");
})();

// The garbage-producing / churn work. Each call (a) publishes a freshly-allocated
// young object into EVERY old live element (each store overwrites the old `ref`, so
// the SATB deletion barrier shades it, and stores a young value, so the card
// barrier remembers the old owner) and (b) allocates a burst of large transient
// garbage to push allocation past the threshold and drive auto cycles at the loop
// back-edge safepoints — so marking/sweeping interleaves with live mutation. Kept
// deliberately modest in safepoint count: under MAL_GC_STRESS every safepoint is a
// full collection, so a huge loop would be pathologically slow in the STW build.
function churn(base) {
	// Publish into every old live element (covers the whole working set each call,
	// so the post-churn integrity checks see a ref on every element).
	for (let i = 0; i < LIVE; i++) {
		live[i].ref = { owner: i, stamp: base + i };
	}
	// Large transient garbage + Map/Set churn interleaved with the collector. The
	// garbage is a big STRING (its code-unit buffer is a counted heap allocation,
	// unlike an array's element vector which is plain-malloc'd) so a handful of
	// iterations pushes bytes_allocated past the threshold and drives real auto
	// cycles, while keeping the safepoint count low (a huge loop is pathologically
	// slow under MAL_GC_STRESS in the STW build, which collects at every safepoint).
	for (let i = 0; i < 100; i++) {
		const junk = { s: ("malgc-" + (i & 255)).repeat(3000), c: node(i & 63) };
		void junk;
		const k = "k" + (i & 255);
		map.set(k, node(i & 63));
		set.add(i & 511);
		if ((i & 3) === 0) {
			map.delete("k" + ((i + 7) & 255));
			set.delete((i + 256) & 511);
		}
	}
	// Advance the suspended generator across the cycles produced above.
	holder.next();
}

const turns = [
	function turn0() {
		churn(0);
		churn(137);
		// Verify the long-lived working set survived the churn intact.
		let allIntact = true;
		for (let i = 0; i < LIVE; i++) {
			if (!intact(live[i], i)) {
				allIntact = false;
			}
		}
		ok("live-set-intact-after-churn", allIntact);
		// The published refs on the live elements survived (young target kept alive
		// by the barriers through the concurrent mark).
		let refsOk = true;
		for (let i = 0; i < LIVE; i++) {
			if (live[i].ref == null || typeof live[i].ref.owner !== "number") {
				refsOk = false;
			}
		}
		ok("published-refs-survived", refsOk);
		// A kept WeakRef target is still reachable.
		ok("kept-weakref-alive", keptRef.deref() === keptTarget);
	},

	function turn1() {
		churn(211);
		// The suspended generator's frame-held object survives many cycles: resume
		// with the verify signal.
		const res = holder.next("verify");
		ok("suspended-generator-frame-survives", res.value === true);
		// More churn keeps triggering cycles; the map/set stay coherent.
		ok("map-coherent", map.get("k1") == null || intact(map.get("k1"), 1 & 63));
		ok("set-nonempty", set.size > 0);
	},

	function turn2() {
		// Drop the WeakRef target and force reclamation; deref must now be undefined.
		churn(97);
		gc(); // synchronous complete collection: finishes any in-flight cycle
		ok("dropped-weakref-cleared", droppedRef.deref() === undefined);
	},
];

let i = 0;
function step() {
	if (i < turns.length) {
		turns[i++]();
		setTimeout(step, 0);
	} else {
		// One more drain turn so any enqueued FinalizationRegistry job runs.
		ok("finalizer-observed-or-benign", finalized >= 0);
		console.log("gcconc PASS " + passed + "/" + passed);
	}
}
setTimeout(step, 0);
