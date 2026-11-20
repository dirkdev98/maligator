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

// Replacing the prototype methods after warm-up must reach every site. Locked
// primordials reject the replacement, and the sites must keep the builtins.
const originalGet = Map.prototype.get;
const originalHas = Set.prototype.has;
const originalWeakGet = WeakMap.prototype.get;
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
	Map.prototype.get = originalGet;
	Set.prototype.has = originalHas;
	WeakMap.prototype.get = originalWeakGet;
} else {
	assert(Map.prototype.get === originalGet, "locked Map.prototype.get is unchanged");
	assert(plain.weakWrite({}, 3) === 3, "locked WeakMap.prototype.get");
	assert(readAny(looseMap, "a") === 1, "locked get at an unknown site");
}
assert(plain.read("k4") === 1993, "restored Map.prototype.get");
assert(plain.mark("never-seen") === true, "restored Set.prototype.has");
assert(plain.mark("never-seen") === false, "restored Set.prototype.has sees the add");

console.log("exact-collection-capture PASS");
