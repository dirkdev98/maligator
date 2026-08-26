function assert(condition, message) {
	if (!condition) throw new Error(message);
}

class Registry {
	#map = new Map([["answer", { value: 42 }]]);
	#set = new Set(["present"]);

	read(key) {
		return this.#map.get(key);
	}

	write(key, value) {
		return this.#map.set(key, value) === this.#map;
	}

	contains(key) {
		return this.#map.has(key) && this.#set.has(key);
	}

	remove(key) {
		return this.#map.delete(key) && this.#set.delete(key);
	}

	add(value) {
		return this.#set.add(value) === this.#set;
	}

	shadowedGet(key) {
		this.#map.get = function (requested) {
			return `shadow:${requested}`;
		};
		return this.#map.get(key);
	}

	crossBrandHasThrows() {
		this.#map.has = Set.prototype.has;
		try {
			this.#map.has("present");
			return false;
		} catch (error) {
			return error instanceof TypeError;
		}
	}
}

const registry = new Registry();
assert(registry.read("answer").value === 42, "private Map read");
assert(registry.write("present", { value: 7 }), "private Map write");
assert(registry.add("present"), "private Set add");
assert(registry.contains("present"), "private Map and Set has");
assert(registry.remove("present"), "private Map and Set delete");
assert(registry.shadowedGet("answer") === "shadow:answer", "own callee fallback");

const crossBrandRegistry = new Registry();
assert(crossBrandRegistry.crossBrandHasThrows(), "cross-brand callee fallback");

const globalMap = new Map([["global", 9]]);
const globalSet = new Set(["global"]);
function readGlobals(key) {
	return globalMap.get(key) + (globalSet.has(key) ? 1 : 0);
}
assert(readGlobals("global") === 10, "single-assignment global brands");

const collect = globalThis.__mal_collect_garbage;
if (typeof collect === "function") {
	collect();
	assert(registry.read("answer").value === 42, "private collection values stay rooted");
}

console.log("exact-collection-receiver PASS");
