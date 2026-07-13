// Targeted GC unit tests: the WeakMap ephemeron fixpoint. Plain ephemeron death (a
// dead key drops its entry and reclaims the value), CHAINED ephemeron revival (the
// value of one WeakMap entry is the key of the next; holding only the head must
// keep the whole chain alive — a single non-fixpoint marking pass would drop the
// tail), and the ephemeron INVARIANT that a key reachable only from its own value
// does NOT stay alive (key-in-own-value must be collected, not leaked). Observed
// via WeakRef across a microtask checkpoint on the HOST event loop under
// MAL_HOST_GC. A failed assertion throws; the final "gcephemeron PASS N/N" prints
// only on full success.

const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("gcephemeron requires MAL_HOST_GC=1 (gc hook absent)");
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

// --- Plain ephemeron death: entry with an unreachable key. ---
const wmPlain = new WeakMap();
let plainKeyRef, plainValRef;
function buildPlain() {
	let deadKey = {};
	let bigVal = { id: "eph-val", big: new Array(2000).fill(7) };
	wmPlain.set(deadKey, bigVal);
	plainKeyRef = new WeakRef(deadKey);
	plainValRef = new WeakRef(bigVal);
}

// --- Chained ephemeron: wmA[k1] = k2, wmB[k2] = marker. Only k1 is held. ---
const wmA = new WeakMap();
const wmB = new WeakMap();
let k1 = { id: "k1" }; // held strongly for the whole run
let markerRef, k2Ref;
function buildChain() {
	let k2 = { id: "k2" };
	let marker = { id: "chain-marker", big: new Array(1000).fill(9) };
	wmA.set(k1, k2);
	wmB.set(k2, marker);
	k2Ref = new WeakRef(k2);
	markerRef = new WeakRef(marker);
}

// --- Ephemeron invariant: key reachable only from its own value must be collected.
//     k <- (wm value) v, and v.backref = k. Neither is externally reachable, so a
//     correct fixpoint reclaims both; treating the value as unconditionally strong
//     would leak k (and v) forever. ---
const wmCycle = new WeakMap();
let cycKeyRef, cycValRef;
function buildKeyInOwnValue() {
	let k = { id: "self-key" };
	let v = { id: "self-val", backref: k, big: new Array(1000).fill(5) };
	wmCycle.set(k, v);
	cycKeyRef = new WeakRef(k);
	cycValRef = new WeakRef(v);
}

const turns = [
	// Turn 0: build. WeakRef constructors pin every target for THIS turn, so a
	// STRESS gc cannot reclaim them before the checkpoint clears the kept set.
	function build() {
		buildPlain();
		buildChain();
		buildKeyInOwnValue();
	},

	// Turn 1: collect. The checkpoint after turn 0 cleared the kept set, so only
	// genuine liveness remains. The chain survives via k1; everything else dies.
	function collect() {
		gc();
		// Chain liveness is observable immediately (still-live targets).
		ok("chain-k2-alive-via-k1", wmA.get(k1) !== undefined && wmA.get(k1).id === "k2");
		ok("chain-marker-alive-via-fixpoint", wmB.get(wmA.get(k1)) !== undefined);
		ok(
			"chain-marker-weakref-alive",
			markerRef.deref() !== undefined && markerRef.deref().id === "chain-marker",
		);
		ok("chain-k2-weakref-alive", k2Ref.deref() !== undefined);
	},

	// Turn 2: the dead entries' targets are reclaimed. Deref confirms both the key
	// and the value went away in each dead case — no ephemeron leak.
	function verify() {
		ok("plain-dead-key-reclaimed", plainKeyRef.deref() === undefined);
		ok("plain-value-reclaimed", plainValRef.deref() === undefined);
		ok("keyinvalue-key-reclaimed", cycKeyRef.deref() === undefined);
		ok("keyinvalue-value-reclaimed", cycValRef.deref() === undefined);
		// Chain still alive after another collection (k1 still held).
		gc();
		ok(
			"chain-still-alive-after-second-gc",
			markerRef.deref() !== undefined && k2Ref.deref() !== undefined,
		);
	},
];

let i = 0;
function step() {
	if (i < turns.length) {
		turns[i++]();
		setTimeout(step, 0);
	} else {
		console.log("gcephemeron PASS " + passed + "/" + passed);
	}
}
setTimeout(step, 0);
