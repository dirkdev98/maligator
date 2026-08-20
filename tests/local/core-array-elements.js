function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function presentElements(seed) {
	const values = [seed, seed + 1];
	const before = values[0];
	values[0] = seed + 2;
	return before + values["0"] + values.length;
}

function overwrittenElement(seed) {
	const values = [0];
	values[0] = seed;
	values[0] = seed + 1;
	return values[0];
}

function unreadStores(seed) {
	const values = [0];
	values[0] = seed;
	values[0] = seed + 1;
	return seed + 2;
}

let calls = 0;
function bump() {
	calls += 1;
}
function acrossCall(seed) {
	const values = [seed];
	const before = values[0];
	bump();
	return before + values[0];
}

function storeThenThrow(seed) {
	const values = [0];
	let observed = -1;
	try {
		values[0] = seed;
		if (seed > 0) throw new Error("stop");
		values[0] = seed + 1;
	} catch {
		observed = values[0];
	}
	return observed;
}

function* suspending(seed) {
	const values = [seed];
	const before = values[0];
	yield 1;
	return before + values[0];
}

function perIteration(limit) {
	let total = 0;
	for (let index = 0; index < limit; index++) {
		const values = [index];
		if (index > 0) values[0] = values[0] * 2;
		total += values[0];
	}
	return total;
}

let arrayPrototypeReads = 0;
function arrayPrototypeHole(seed) {
	Object.defineProperty(Array.prototype, "17", {
		configurable: true,
		get() {
			arrayPrototypeReads += 1;
			return 70;
		},
	});
	const values = [seed, , , , , , , , , , , , , , , , , ,];
	const result = values[17] + values[17];
	delete Array.prototype[17];
	return result;
}

let objectPrototypeReads = 0;
function objectPrototypeHole(seed) {
	Object.defineProperty(Object.prototype, "18", {
		configurable: true,
		get() {
			objectPrototypeReads += 1;
			return 80;
		},
	});
	const values = [seed, , , , , , , , , , , , , , , , , , ,];
	const result = values[18] + values[18];
	delete Object.prototype[18];
	return result;
}

let shadowedReads = 0;
function ownShadowsPrototype(seed) {
	Object.defineProperty(Array.prototype, "19", {
		configurable: true,
		get() {
			shadowedReads += 1;
			return 90;
		},
	});
	const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, seed];
	const result = values[19] + values["19"];
	delete Array.prototype[19];
	return result;
}

function deleted(seed) {
	const values = [seed, seed + 1];
	delete values[0];
	return (values[0] === undefined ? 1 : 0) + values[1];
}

function truncated(seed) {
	const values = [seed, seed + 1];
	values.length = 1;
	return values[1] === undefined ? values.length : 100;
}

function accessor(seed) {
	const values = [seed];
	let reads = 0;
	Object.defineProperty(values, "0", {
		configurable: true,
		get() {
			reads += 1;
			return seed + 3;
		},
	});
	return values[0] + values["0"] + reads;
}

function reparented(seed) {
	const values = [seed, ,];
	Object.setPrototypeOf(values, {
		get 1() {
			return 9;
		},
	});
	return values[0] + values[1];
}

function proxied(seed) {
	const values = [seed];
	let traps = 0;
	const proxy = new Proxy(values, {
		get(target, key) {
			traps += 1;
			return target[key] + 1;
		},
	});
	return proxy[0] + values[0] + traps;
}

const holder = { value: null };
function escaped(seed) {
	const values = [seed];
	holder.value = values;
	return holder.value[0];
}

function nonIndexKeys(seed) {
	const values = [seed];
	values["00"] = seed + 1;
	values["1e0"] = seed + 2;
	values[-1] = seed + 3;
	values[4294967295] = seed + 4;
	return values[0] + values["00"] + values["1e0"] + values[-1] + values[4294967295];
}

let watched;
function heldThroughUnreadElement() {
	const target = { tag: 1 };
	const watcher = new WeakRef(target);
	const values = [null];
	values[0] = target;
	watched = watcher;
	return watcher.deref() === values[0] ? 1 : 0;
}

const registry = new FinalizationRegistry(() => {});
function registeredArray(seed) {
	const values = [seed];
	registry.register(values, "array");
	return values[0];
}

assert(presentElements(3) === 10, "present elements and length");
assert(overwrittenElement(4) === 5, "last element store wins");
assert(unreadStores(4) === 6, "unread element stores are unobservable");
assert(acrossCall(5) === 10 && calls === 1, "private element survives call");
assert(storeThenThrow(6) === 6, "handler sees the store that ran");
assert(storeThenThrow(0) === -1, "handler is skipped without a throw");
const suspended = suspending(7);
assert(suspended.next().value === 1, "generator yielded");
assert(suspended.next().value === 14, "private element survives suspension");
assert(perIteration(4) === 12, "fresh element per loop iteration");
assert(arrayPrototypeHole(1) === 140 && arrayPrototypeReads === 2, "Array hole getter");
assert(
	objectPrototypeHole(1) === 160 && objectPrototypeReads === 2,
	"Object hole getter",
);
assert(ownShadowsPrototype(4) === 8 && shadowedReads === 0, "own element shadows getter");
assert(deleted(8) === 10, "deleted element becomes a hole");
assert(truncated(9) === 1, "length truncation removes an element");
assert(accessor(10) === 28, "element converted to accessor");
assert(reparented(11) === 20, "reparented hole sees getter");
assert(proxied(12) === 26, "proxy traps only proxy reads");
assert(escaped(13) === 13, "escaped array remains observable");
assert(nonIndexKeys(2) === 20, "non-index property names stay distinct");
assert(
	heldThroughUnreadElement() === 1 && watched.deref() !== undefined,
	"WeakRef value",
);
assert(registeredArray(14) === 14, "registered array remains observable");

console.log("core-array-elements PASS");
