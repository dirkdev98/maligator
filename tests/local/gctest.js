// Targeted GC unit tests (T6.4). Deterministic assertions about the collector's
// observable contract, driven by the real forced-collection hook + a live-bytes
// diagnostic the runtime installs under MAL_HOST_GC. Run via `node
// scripts/gctest.ts` (builds + runs with MAL_HOST_GC=1, optionally under
// MAL_GC_STRESS/VERIFY). A failed assertion throws -> non-zero exit.
//
// Covers: cycle reclamation (tracing backstop), WeakMap ephemeron death +
// chained-ephemeron revival (the fixpoint), WeakRef liveness, and root-frame
// correctness (a value held across an allocating + collecting callee survives).

const gc = globalThis.__mal_collect_garbage;
const liveBytes = globalThis.__mal_gc_live_bytes;
if (typeof gc !== "function" || typeof liveBytes !== "function") {
	throw new Error("gctest requires MAL_HOST_GC=1 (gc hooks absent)");
}

let passed = 0;
function ok(name, cond) {
	if (cond) {
		passed++;
		console.log("PASS " + name);
	} else {
		throw new Error("FAIL " + name);
	}
}

// 1. Cycle reclamation: a large unreachable cyclic structure must be swept.
//    Build it in a callee so nothing roots it after return, then compare the
//    surviving-byte count across collections.
function makeCycleGarbage(n) {
	for (let i = 0; i < n; i++) {
		let a = { big: new Array(2000).fill(i) };
		let b = { big: new Array(2000).fill(i) };
		a.peer = b;
		b.peer = a; // cycle: refcounting would leak this; tracing must reclaim it
	}
}
gc();
const baseLive = liveBytes();
makeCycleGarbage(400); // ~ many MB of cyclic arrays, all dead on return
gc();
const afterLive = liveBytes();
ok("cycle-reclaimed", afterLive - baseLive < 1_000_000);

// 2. WeakMap ephemeron death: an entry whose key is unreachable is dropped, and
//    its (large) value reclaimed.
const wm = new WeakMap();
(function () {
	let deadKey = {};
	wm.set(deadKey, { big: new Array(200000).fill(7) }); // ~big value
})();
gc();
const afterDeadKey = liveBytes();
ok("ephemeron-dead-key-reclaimed", afterDeadKey - baseLive < 2_000_000);

// 3. Chained ephemeron revival (the fixpoint): wmA[k1] = k2, wmB[k2] = big.
//    Holding only k1 (+ both maps) must keep k2 alive THROUGH wmA, which in turn
//    keeps wmB's entry (and `big`) alive. A non-fixpoint pass would drop wmB[k2].
const wmA = new WeakMap();
const wmB = new WeakMap();
let k1 = { id: "k1" };
let bigMarker = { tag: "survivor", big: new Array(1000).fill(9) };
(function () {
	let k2 = { id: "k2" };
	wmA.set(k1, k2);
	wmB.set(k2, bigMarker);
})();
gc();
ok("chained-ephemeron-k2-alive", wmA.get(k1) !== undefined && wmA.get(k1).id === "k2");
ok("chained-ephemeron-value-alive", wmB.get(wmA.get(k1)) === bigMarker);

// 4. WeakRef: a ref to a still-held target derefs to it after a collection.
let held = { tag: "held" };
const ref = new WeakRef(held);
gc();
ok("weakref-live-target-survives", ref.deref() === held);

// 5. Root-frame correctness: a value held in a local across a callee that
//    allocates heavily AND forces collection must survive intact.
function allocAndCollect() {
	makeCycleGarbage(50);
	gc();
	return 0;
}
let guarded = { a: 1, b: "two", c: [3, 4, 5] };
allocAndCollect();
ok(
	"root-frame-value-survives-callee-gc",
	guarded.a === 1 && guarded.b === "two" && guarded.c[2] === 5,
);

console.log("gctest PASS " + passed + "/" + passed);
