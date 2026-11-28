function assert(condition, message) {
	if (!condition) throw new Error(message);
}

// Private fields only ever hold their intrinsic collections, so every method call
// below has a receiver the compiler proves is an exact Map, Set, WeakMap or WeakSet.
class Index {
	#entries = new Map();
	#seen = new Set();
	#weak = new WeakMap();
	#tags = new WeakSet();

	read(key) {
		return this.#entries.get(key);
	}

	write(key, value) {
		this.#entries.set(key, value);
		return this.#entries.has(key);
	}

	mark(key) {
		if (this.#seen.has(key)) return false;
		this.#seen.add(key);
		return true;
	}

	unmark(key) {
		return this.#seen.delete(key);
	}

	weakWrite(key, value) {
		this.#weak.set(key, value);
		return this.#weak.get(key);
	}

	tag(key) {
		this.#tags.add(key);
		return this.#tags.has(key);
	}

	entries() {
		return this.#entries;
	}

	seen() {
		return this.#seen;
	}

	weak() {
		return this.#weak;
	}
}

function warm(index, rounds) {
	let total = 0;
	const owner = {};
	for (let i = 0; i < rounds; i++) {
		const key = `k${i % 17}`;
		index.write(key, i);
		total += index.read(key);
		if (index.mark(key)) total++;
		if (i % 5 === 0) index.unmark(key);
		total += index.weakWrite(owner, i);
		if (index.tag(owner)) total++;
	}
	return total;
}

const plain = new Index();
const warmed = warm(plain, 2000);
assert(warmed === warm(new Index(), 2000), "warm-up is deterministic");
assert(plain.read("k3") === 1992, "exact Map get after warm-up");

plain.entries().label = "not a method";
assert(plain.read("k3") === 1992, "an unrelated own property keeps the builtin get");
assert(plain.write("label-key", 5), "an unrelated own property keeps the builtin set");

const shadowed = new Index();
warm(shadowed, 50);
shadowed.entries().get = (key) => `own:${key}`;
shadowed.seen().has = () => true;
shadowed.weak().get = () => "own weak";
assert(shadowed.read("k1") === "own:k1", "own get shadows Map.prototype.get");
assert(shadowed.mark("fresh") === false, "own has shadows Set.prototype.has");
assert(shadowed.weakWrite({}, 1) === "own weak", "own get shadows WeakMap.prototype.get");
assert(plain.read("k1") === 1990, "other instances keep the builtin get");
assert(plain.mark("fresh") === true, "other instances keep the builtin has");

class CountingMap extends Map {
	get(key) {
		return `counted:${super.get(key)}`;
	}
}
const reparented = new Index();
warm(reparented, 50);
Object.setPrototypeOf(reparented.entries(), CountingMap.prototype);
assert(reparented.read("k2") === "counted:36", "a reparented Map uses its new prototype");
assert(plain.read("k2") === 1991, "a reparented sibling keeps the builtin get");

// A receiver the compiler cannot brand meets builtin, subclass and look-alike receivers.
class Lookup {
	get(key) {
		return `lookup:${key}`;
	}
	has(key) {
		return key === "always";
	}
}
function readAny(store, key) {
	return store.get(key);
}
function hasAny(store, key) {
	return store.has(key);
}
const looseMap = new Map([["a", 1]]);
const looseSubclass = new CountingMap([["a", 2]]);
const lookup = new Lookup();
const looseSet = new Set(["a"]);
for (let i = 0; i < 200; i++) {
	assert(readAny(looseMap, "a") === 1, "unknown receiver: Map");
	assert(readAny(looseSubclass, "a") === "counted:2", "unknown receiver: Map subclass");
	assert(readAny(lookup, "a") === "lookup:a", "unknown receiver: class with get");
	assert(hasAny(looseSet, "a") === true, "unknown receiver: Set");
	assert(hasAny(lookup, "always") === true, "unknown receiver: class with has");
}

function writeAny(store, key, value) {
	return store.set(key, value);
}
function addAny(store, value) {
	return store.add(value);
}
function deleteAny(store, key) {
	return store.delete(key);
}
function rejects(run) {
	try {
		run();
		return false;
	} catch (error) {
		return error instanceof TypeError;
	}
}
class CountingSet extends Set {
	add(value) {
		return super.add(`counted:${value}`);
	}
	has(value) {
		return super.has(`counted:${value}`);
	}
}
const ownMethods = new Map([["a", 1]]);
ownMethods.get = (key) => `own get:${key}`;
ownMethods.set = () => "own set";
ownMethods.has = () => "own has";
ownMethods.delete = () => "own delete";
const ownAdd = new Set(["a"]);
ownAdd.add = () => "own add";
const proxiedMap = new Proxy(new Map([["a", 1]]), {});
const proxiedSet = new Proxy(new Set(["a"]), {});
const trappedMap = new Proxy(new Map(), {
	get: (target, key) => (key === "get" ? () => "trapped get" : Reflect.get(target, key)),
});
for (let i = 0; i < 200; i++) {
	assert(writeAny(looseMap, "b", i) === looseMap, "unknown receiver: Map set");
	assert(readAny(looseMap, "b") === i, "unknown receiver: Map get after set");
	assert(hasAny(looseMap, "b") === true, "unknown receiver: Map has");
	assert(deleteAny(looseMap, "b") === true, "unknown receiver: Map delete");
	assert(
		deleteAny(looseMap, "b") === false,
		"unknown receiver: Map delete of a missing key",
	);
	assert(addAny(looseSet, i) === looseSet, "unknown receiver: Set add");
	assert(hasAny(looseSet, i) === true, "unknown receiver: Set has after add");
	assert(deleteAny(looseSet, i) === true, "unknown receiver: Set delete");
	assert(hasAny(looseSet, i) === false, "unknown receiver: Set has after delete");
	const counting = new CountingSet();
	assert(addAny(counting, i) === counting, "unknown receiver: Set subclass add");
	assert(hasAny(counting, i) === true, "unknown receiver: Set subclass has");
	assert(
		Set.prototype.has.call(counting, `counted:${i}`),
		"Set subclass add stores its value",
	);
	assert(
		writeAny(looseSubclass, "b", i) === looseSubclass,
		"unknown receiver: Map subclass set",
	);
	assert(
		readAny(looseSubclass, "b") === `counted:${i}`,
		"unknown receiver: Map subclass get",
	);
	assert(readAny(ownMethods, "a") === "own get:a", "unknown receiver: own get");
	assert(writeAny(ownMethods, "a", i) === "own set", "unknown receiver: own set");
	assert(hasAny(ownMethods, "a") === "own has", "unknown receiver: own has");
	assert(deleteAny(ownMethods, "a") === "own delete", "unknown receiver: own delete");
	assert(addAny(ownAdd, i) === "own add", "unknown receiver: own add");
	assert(
		rejects(() => readAny(proxiedMap, "a")),
		"unknown receiver: proxied Map get",
	);
	assert(
		rejects(() => hasAny(proxiedSet, "a")),
		"unknown receiver: proxied Set has",
	);
	assert(
		rejects(() => addAny(proxiedSet, "a")),
		"unknown receiver: proxied Set add",
	);
	assert(readAny(trappedMap, "a") === "trapped get", "unknown receiver: proxy get trap");
}

// Replacing the prototype methods after warm-up must reach every site. Locked
// primordials reject the replacement, and the sites must keep the builtins.
const originalGet = Map.prototype.get;
const originalHas = Set.prototype.has;
const originalWeakGet = WeakMap.prototype.get;
const originalSet = Map.prototype.set;
const originalMapDelete = Map.prototype.delete;
const originalAdd = Set.prototype.add;
const originalSetDelete = Set.prototype.delete;
function replaceMethods() {
	try {
		Map.prototype.get = function (key) {
			return `patched:${originalGet.call(this, key)}`;
		};
		Set.prototype.has = function () {
			return true;
		};
		WeakMap.prototype.get = function () {
			return "patched weak";
		};
		Map.prototype.set = () => "patched set";
		Map.prototype.delete = () => "patched Map delete";
		Set.prototype.add = () => "patched add";
		Set.prototype.delete = () => "patched Set delete";
		return true;
	} catch (error) {
		assert(error instanceof TypeError, "locked primordials reject replacement");
		return false;
	}
}
if (replaceMethods()) {
	assert(plain.read("k4") === "patched:1993", "replaced Map.prototype.get");
	assert(plain.mark("never-seen") === false, "replaced Set.prototype.has");
	assert(plain.weakWrite({}, 3) === "patched weak", "replaced WeakMap.prototype.get");
	assert(readAny(looseMap, "a") === "patched:1", "replaced get at an unknown site");
	assert(writeAny(looseMap, "a", 2) === "patched set", "replaced set at an unknown site");
	assert(deleteAny(looseMap, "a") === "patched Map delete", "replaced Map delete");
	assert(addAny(looseSet, "z") === "patched add", "replaced add at an unknown site");
	assert(deleteAny(looseSet, "a") === "patched Set delete", "replaced Set delete");
	Map.prototype.get = originalGet;
	Set.prototype.has = originalHas;
	WeakMap.prototype.get = originalWeakGet;
	Map.prototype.set = originalSet;
	Map.prototype.delete = originalMapDelete;
	Set.prototype.add = originalAdd;
	Set.prototype.delete = originalSetDelete;
} else {
	assert(Map.prototype.get === originalGet, "locked Map.prototype.get is unchanged");
	assert(plain.weakWrite({}, 3) === 3, "locked WeakMap.prototype.get");
	assert(readAny(looseMap, "a") === 1, "locked get at an unknown site");
	assert(writeAny(looseMap, "a", 1) === looseMap, "locked set at an unknown site");
	assert(addAny(looseSet, "a") === looseSet, "locked add at an unknown site");
}
assert(readAny(looseMap, "a") === 1, "restored set at an unknown site");
assert(hasAny(looseSet, "a") === true, "restored Set delete at an unknown site");
assert(plain.read("k4") === 1993, "restored Map.prototype.get");
assert(plain.mark("never-seen") === true, "restored Set.prototype.has");
assert(plain.mark("never-seen") === false, "restored Set.prototype.has sees the add");

console.log("exact-collection-capture PASS");
