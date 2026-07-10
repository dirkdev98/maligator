// Targeted GC unit tests: the weak pass (cycle reclamation observed via WeakRef +
// FinalizationRegistry, WeakRef deref before/after target death, ClearKeptObjects
// at the microtask checkpoint, FinalizationRegistry callback/unregister/held-value
// identity). Driven by the MAL_HOST_GC forced-collection hook on the HOST event
// loop, so each setTimeout turn ends with a real microtask checkpoint: a target
// pinned by a deref (or a freshly-constructed WeakRef) survives its own turn, then
// ClearKeptObjects unpins it, so the next turn's gc() reclaims it and any enqueued
// FinalizationRegistry cleanup job has drained. A failed assertion throws (non-zero
// exit) and prints the failing name; the final "gcweak PASS N/N" line only prints
// on full success.

const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("gcweak requires MAL_HOST_GC=1 (gc hook absent)");
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

// FinalizationRegistry cleanup callbacks record the held value they receive, keyed
// by that value, so a test can assert both delivery and held-value identity.
const finalized = new Map();
const registry = new FinalizationRegistry((held) => {
	finalized.set(typeof held === "object" && held !== null ? held.id : held, held);
});

// --- Garbage constructed in helpers so no caller local roots it after return. ---

// Plain two-object cycle: a.peer = b; b.peer = a. Refcounting would leak it.
function makeObjectCycle(id) {
	let a = { id, kind: "obj-a", big: new Array(500).fill(id) };
	let b = { id, kind: "obj-b", peer: a };
	a.peer = b;
	registry.register(a, "cycle-obj:" + id);
	return new WeakRef(a);
}

// Cycle through a closure captured in a Map value (env <-> map <-> closure).
function makeClosureMapCycle(id) {
	let m = new Map();
	let fn = function () {
		return m.size + id;
	};
	m.set("self", fn); // fn's env captures m; m holds fn -> cycle
	registry.register(m, "cycle-map:" + id);
	return new WeakRef(m);
}

// Self-referential array: arr[0] = arr.
function makeSelfRefArray(id) {
	let arr = new Array(300).fill(id);
	arr[0] = arr;
	registry.register(arr, "cycle-arr:" + id);
	return new WeakRef(arr);
}

// A registry entry with an unregister token, and a held value we later assert did
// NOT fire because we unregister before dropping the target.
function makeUnregistered(id) {
	let target = { id, kind: "unreg" };
	let token = {};
	registry.register(target, "unreg:" + id, token);
	registry.unregister(token);
	return new WeakRef(target);
}

// Held-value identity: the cleanup must receive the exact heldValue object.
const heldIdentityObject = { id: "held-identity", marker: 123 };
function makeHeldIdentity() {
	let target = { kind: "held-identity-target" };
	registry.register(target, heldIdentityObject);
	return new WeakRef(target);
}

// --- Live target held for the whole run, plus a ClearKeptObjects probe. ---
let liveTarget = { tag: "live" };
const liveRef = new WeakRef(liveTarget);

let keptRef; // set in turn A, observed across the checkpoint in turn B

let cycleRefs = {};

const turns = [
	// Turn 0: build all garbage. WeakRef/FinReg only hold weakly; the constructor
	// pins each target for THIS turn (AddToKeptObjects), so a STRESS gc here cannot
	// reclaim them early. No gc() yet.
	function build() {
		cycleRefs.obj = makeObjectCycle(1);
		cycleRefs.map = makeClosureMapCycle(2);
		cycleRefs.arr = makeSelfRefArray(3);
		cycleRefs.unreg = makeUnregistered(4);
		cycleRefs.held = makeHeldIdentity();

		// ClearKeptObjects probe: construct a WeakRef (pins target this turn) and
		// deref it (re-pins). The target local dies at turn end; only keptRef + the
		// kept set reach it.
		(function () {
			let obj = { tag: "kept" };
			keptRef = new WeakRef(obj);
			ok("clearkept-pinned-same-turn", keptRef.deref() === obj);
		})();
	},

	// Turn 1: the checkpoint after turn 0 ran ClearKeptObjects, so every target is
	// now only weakly reachable. Collect. The live target must survive; the kept
	// probe target must now be reclaimable (nothing strong holds it).
	function collect() {
		gc();
		ok("weakref-live-target-survives", liveRef.deref() === liveTarget && liveRef.deref().tag === "live");
		ok("clearkept-reclaimed-next-turn", keptRef.deref() === undefined);
	},

	// Turn 2: the checkpoint after turn 1 drained the FinalizationRegistry cleanup
	// jobs the collect enqueued. Every dropped cycle is gone (WeakRef nulled), the
	// callbacks fired with the right held values, and the unregistered entry did
	// NOT fire.
	function verify() {
		ok("cycle-obj-reclaimed", cycleRefs.obj.deref() === undefined);
		ok("cycle-map-reclaimed", cycleRefs.map.deref() === undefined);
		ok("cycle-arr-reclaimed", cycleRefs.arr.deref() === undefined);
		ok("unreg-target-reclaimed", cycleRefs.unreg.deref() === undefined);
		ok("held-identity-target-reclaimed", cycleRefs.held.deref() === undefined);

		ok("finreg-fired-obj", finalized.get("cycle-obj:1") === "cycle-obj:1");
		ok("finreg-fired-map", finalized.get("cycle-map:2") === "cycle-map:2");
		ok("finreg-fired-arr", finalized.get("cycle-arr:3") === "cycle-arr:3");
		ok("finreg-unregistered-did-not-fire", !finalized.has("unreg:4"));
		ok(
			"finreg-held-value-identity",
			finalized.get("held-identity") === heldIdentityObject &&
				finalized.get("held-identity").marker === 123,
		);
	},
];

// Drive the turns, one per macrotask, so a microtask checkpoint runs between each.
let i = 0;
function step() {
	if (i < turns.length) {
		turns[i++]();
		setTimeout(step, 0);
	} else {
		console.log("gcweak PASS " + passed + "/" + passed);
	}
}
setTimeout(step, 0);
