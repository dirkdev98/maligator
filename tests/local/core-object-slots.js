function assert(condition, message) {
	if (!condition) throw new Error(message);
}

// Own data slots of a frame-local literal: reads must see the initial values and
// the store, across coercions that cannot reach the object.
function ownSlots(seed) {
	const o = { f0: seed, f1: seed + 1, f2: seed + 2 };
	if (seed > 0) o.f2 = o.f0 + o.f1;
	return o.f0 + o.f1 + o.f2;
}

function overwrittenSlot(seed) {
	const o = { value: 0 };
	o.value = seed;
	o.value = seed + 1;
	return o.value;
}

function unreadStores(seed) {
	const o = { value: 0 };
	o.value = seed;
	o.value = seed + 1;
	return seed + 2;
}

// A key outside the literal reaches the prototype chain, where an accessor
// receives the object as its receiver.
let inheritedReads = 0;
Object.defineProperty(Object.prototype, "inherited", {
	configurable: true,
	get() {
		inheritedReads += 1;
		return this.f0 + 100;
	},
});
function inheritedKey(seed) {
	const o = { f0: seed };
	return o.inherited + o.inherited;
}

let shadowedPrototypeReads = 0;
Object.defineProperty(Object.prototype, "shadowed", {
	configurable: true,
	get() {
		shadowedPrototypeReads += 1;
		return 1000;
	},
});
function ownKeyShadowsPrototype(seed) {
	const o = { shadowed: seed };
	return o.shadowed + o.shadowed;
}

// Converting an own slot to an accessor after the fact must be observed.
function ownAccessor(seed) {
	const o = { f0: seed };
	let getterCalls = 0;
	Object.defineProperty(o, "f0", {
		configurable: true,
		get() {
			getterCalls += 1;
			return seed + 7;
		},
	});
	return o.f0 + o.f0 + getterCalls;
}

function deletedSlot(seed) {
	const o = { f0: seed, f1: seed + 1 };
	delete o.f0;
	return (o.f0 === undefined ? 1 : 0) + o.f1;
}

function frozenSlot(seed) {
	const o = { f0: seed };
	Object.freeze(o);
	try {
		o.f0 = seed + 1;
	} catch {
		// Sloppy mode ignores the failed write; a strict caller would throw.
	}
	return o.f0;
}

function reparented(seed) {
	const o = { f0: seed };
	Object.setPrototypeOf(o, {
		get f1() {
			return 9;
		},
	});
	return o.f0 + o.f1;
}

function proxied(seed) {
	const o = { f0: seed };
	let traps = 0;
	const p = new Proxy(o, {
		get(target, key) {
			traps += 1;
			return target[key] + 1;
		},
	});
	return p.f0 + o.f0 + traps;
}

function enumerated(seed) {
	const o = { f0: seed, f1: seed + 1 };
	let total = 0;
	for (const key of Object.keys(o)) total += o[key];
	return total;
}

// A call between two reads cannot reach a frame-local object, but it can reassign
// a module binding, so only the slot value may be reused.
let callCount = 0;
function bump() {
	callCount += 1;
	return callCount;
}
function slotsAcrossCall(seed) {
	const o = { f0: seed };
	const first = o.f0;
	bump();
	return first + o.f0;
}

// An exception between two stores must not expose an intermediate slot value
// through a reference the handler can still see.
function storeThenThrow(seed) {
	const o = { f0: 0 };
	let observed = -1;
	try {
		o.f0 = seed;
		if (seed > 0) throw new Error("stop");
		o.f0 = seed + 1;
	} catch {
		observed = o.f0;
	}
	return observed;
}

// Suspension hands control to user code, which still cannot reach the object.
function* suspending(seed) {
	const o = { f0: seed };
	const before = o.f0;
	yield 1;
	return before + o.f0;
}

// Resumable functions store every register as a boxed MalValue. A failed
// shared shape selection must remain the -1 sentinel after crossing that
// representation boundary so the nested binding reads use their generic path.
function* destructuredShapeMiss(
	{ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = {
		w: { x: undefined, z: 7 },
	},
) {
	yield [x, y, z];
}

// A fresh object per iteration: a read must never reuse a previous iteration's
// slot value.
function perIteration(limit) {
	let total = 0;
	for (let index = 0; index < limit; index++) {
		const o = { f0: index };
		if (index > 0) o.f0 = o.f0 * 2;
		total += o.f0;
	}
	return total;
}

// Adding a key the literal did not declare changes the shape.
function grownShape(seed) {
	const o = { f0: seed };
	o.f1 = seed + 1;
	return o.f0 + o.f1;
}

function identityObserved(seed, other) {
	const o = { f0: seed };
	const same = o === other;
	return (same ? 1000 : 0) + o.f0;
}

const escapedHolder = { value: null };
function escapedByStore(seed) {
	const o = { f0: seed };
	escapedHolder.value = o;
	return escapedHolder.value.f0;
}

let finalizationRoot;
function weaklyHeld(seed) {
	const o = { f0: seed };
	finalizationRoot = new WeakRef(o);
	return o.f0 + (finalizationRoot.deref() === o ? 1 : 0);
}

const finalizationRegistry = new FinalizationRegistry(() => {});
function registeredAggregate(seed) {
	const o = { f0: seed };
	finalizationRegistry.register(o, "aggregate");
	return o.f0;
}

// A slot whose value is a reference a WeakRef watches. The store into the unread
// slot is the only thing keeping the target reachable, so it must survive; the
// deref proves the reference is still there.
function heldThroughUnreadSlot() {
	const target = { tag: 1 };
	const watcher = new WeakRef(target);
	const box = { held: null };
	box.held = target;
	return watcher.deref() === box.held ? 1 : 0;
}

// The reverse direction: dropping the store would keep the initial reference
// reachable through the slot for longer than the program does.
function replacedReference() {
	const first = { tag: 1 };
	const second = { tag: 2 };
	const box = { held: first };
	box.held = second;
	return box.held.tag;
}

assert(ownSlots(3) === 14, "own slots read initial values and the store");
assert(ownSlots(-3) === -6, "own slots read initial values without the store");
assert(overwrittenSlot(4) === 5, "last store wins");
assert(unreadStores(4) === 6, "unread stores do not change the result");
assert(inheritedKey(1) === 202, "inherited accessor runs per read");
assert(inheritedReads === 2, "inherited accessor is not shared between reads");
assert(ownKeyShadowsPrototype(2) === 4, "an own data slot shadows a prototype getter");
assert(shadowedPrototypeReads === 0, "the shadowed prototype getter does not run");
assert(ownAccessor(1) === 18, "own slot converted to an accessor runs the getter twice");
assert(deletedSlot(5) === 7, "deleted slot reads as undefined");
assert(frozenSlot(6) === 6, "frozen slot keeps its value");
assert(reparented(7) === 16, "reparented object sees the new prototype accessor");
assert(proxied(8) === 18, "proxy traps its own reads only");
assert(enumerated(9) === 19, "enumeration sees both slots");
assert(slotsAcrossCall(10) === 20, "slot survives a call that cannot reach it");
assert(callCount === 1, "the call between reads ran once");
assert(storeThenThrow(11) === 11, "handler sees the store that ran");
assert(storeThenThrow(0) === -1, "handler is not entered when nothing throws");
const suspended = suspending(12);
assert(suspended.next().value === 1, "generator yields before resuming");
assert(suspended.next().value === 24, "slot survives suspension");
const destructured = destructuredShapeMiss().next().value;
assert(destructured[0] === undefined, "generator shape miss preserves x");
assert(destructured[1] === undefined, "generator shape miss preserves absent y");
assert(destructured[2] === 7, "generator shape miss preserves z");
assert(perIteration(4) === 12, "each iteration reads its own object");
assert(grownShape(13) === 27, "a grown shape reads both keys");
assert(identityObserved(14, null) === 14, "identity comparison keeps the slot readable");
assert(identityObserved(14, globalThis) === 14, "identity comparison against an object");
assert(escapedByStore(15) === 15, "a reference stored elsewhere remains observable");
assert(weaklyHeld(15) === 16, "weakly held object stays readable");
assert(registeredAggregate(16) === 16, "a registered aggregate remains readable");
assert(heldThroughUnreadSlot() === 1, "a slot keeps a weakly watched reference");
assert(replacedReference() === 2, "an overwritten slot holds the later reference");

console.log("core-object-slots PASS");
