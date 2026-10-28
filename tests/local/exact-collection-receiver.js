function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function readFreshMap(key) {
	const values = new Map();
	values.set("answer", { value: 42 });
	return values.get(key)?.value;
}

assert(readFreshMap("answer") === 42, "contained fresh Map direct calls");

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

function readPassedMap(map, key) {
	return map.get(key);
}
function updatePassedCollections(map, set, key, value) {
	map.set(key, value);
	set.add(key);
	return map.has(key) && set.has(key) ? map.get(key) : -1;
}
assert(readPassedMap(globalMap, "global") === 9, "Map brand crosses a named call");
assert(
	updatePassedCollections(globalMap, globalSet, "passed", 17) === 17,
	"Map and Set brands cross positional parameters",
);

// Publishing a function opens its parameter. Calling it with a
// non-collection after an exact receiver makes a wrong closed-world parameter
// proof observable as a TypeError or stale builtin dispatch.
function readPublishedCollection(receiver, key) {
	return receiver.get(key);
}
globalThis.__mal_read_published_collection = readPublishedCollection;
assert(
	globalThis.__mal_read_published_collection(globalMap, "global") === 9,
	"published function accepts a collection",
);
assert(
	globalThis.__mal_read_published_collection(
		{
			get(key) {
				return `published:${key}`;
			},
		},
		"fallback",
	) === "published:fallback",
	"published parameter remains open",
);

const collect = globalThis.__mal_collect_garbage;

function escapedCollectionOps(visit, key, replacement) {
	const map = new Map();
	const set = new Set();
	visit(map, set);
	const first = Map.prototype.get.call(map, key);
	visit(map, set);
	const second = Map.prototype.get.call(map, key);
	const present = Map.prototype.has.call(map, key) && Set.prototype.has.call(set, key);
	const removed =
		Map.prototype.delete.call(map, key) && Set.prototype.delete.call(set, key);
	const mapAlias = Map.prototype.set.call(map, key, replacement) === map;
	const setAlias = Set.prototype.add.call(set, key) === set;
	return { first, second, present, removed, mapAlias, setAlias, shadowed: map.get(key) };
}
globalThis.__mal_escaped_collection_ops = escapedCollectionOps;
const escapedKey = {
	[Symbol.toPrimitive]() {
		throw new Error("collection key was coerced");
	},
};
const firstPayload = { value: 1 };
const secondPayload = { value: 2 };
let publicationCount = 0;
const escaped = escapedCollectionOps(
	(map, set) => {
		map.set(escapedKey, publicationCount++ === 0 ? firstPayload : secondPayload);
		set.add(escapedKey);
		map.get = () => "shadow";
		set.has = () => false;
		if (typeof collect === "function") collect();
	},
	escapedKey,
	{ value: 3 },
);
assert(
	escaped.first === firstPayload && escaped.second === secondPayload,
	"published collection reads observe intervening callbacks",
);
assert(
	escaped.present && escaped.removed,
	"published collection membership and deletion retain effects",
);
assert(
	escaped.mapAlias && escaped.setAlias,
	"published mutators retain receiver identity",
);
assert(
	escaped.shadowed === "shadow",
	"raw collection brand does not authorize a shadowed method",
);
if (typeof collect === "function") {
	collect();
	assert(registry.read("answer").value === 42, "private collection values stay rooted");
	assert(
		escaped.first.value === 1 && escaped.second.value === 2,
		"published collection results stay rooted",
	);
}

const makeReturnedMap = function makeReturnedMap(visit, choose) {
	for (let i = 0; i < 3; i++) visit();
	return choose ? new Map() : new Map();
};
const makeReturnedArray = function makeReturnedArray(visit, choose) {
	for (let i = 0; i < 3; i++) visit();
	return choose ? [] : [];
};
function readReturnedMap(visit, key, choose) {
	const value = choose
		? makeReturnedMap(visit, choose)
		: makeReturnedMap(...[visit, choose]);
	visit(value);
	return Map.prototype.get.call(value, key);
}
function checkReturnedArray(visit, choose) {
	const value = makeReturnedArray(visit, choose);
	visit(value);
	return Array.isArray(value);
}
function* suspendedReturnedMap(visit, key) {
	const value = makeReturnedMap(visit, true);
	yield value;
	return Map.prototype.get.call(value, key);
}
Object.assign(globalThis, { readReturnedMap, checkReturnedArray, suspendedReturnedMap });
const returnedPayload = { value: "factory" };
const constructedReturnedMap = new makeReturnedMap(() => {}, true);
assert(
	Map.prototype.has.call(constructedReturnedMap, escapedKey) === false,
	"constructor preserves an explicit normal Map return",
);
const publishReturned = (value) => {
	if (value === undefined) return;
	Object.setPrototypeOf(value, null);
	Map.prototype.set.call(value, escapedKey, returnedPayload);
	value.get = () => "shadow";
	if (typeof collect === "function") collect();
};
for (const choose of [false, true]) {
	assert(
		readReturnedMap(publishReturned, escapedKey, choose) === returnedPayload,
		"normal Map returns retain brand after publication",
	);
	assert(
		checkReturnedArray((value) => {
			if (value !== undefined) Object.setPrototypeOf(value, null);
			if (typeof collect === "function") collect();
		}, choose),
		"normal Array return keeps brand after prototype mutation",
	);
}
const suspended = suspendedReturnedMap(() => {}, escapedKey);
const suspendedMap = suspended.next().value;
Map.prototype.set.call(suspendedMap, escapedKey, returnedPayload);
if (typeof collect === "function") collect();
assert(
	suspended.next().value === returnedPayload,
	"normal Map return retains brand and observes mutations across suspension",
);
try {
	readReturnedMap(
		() => {
			throw returnedPayload;
		},
		escapedKey,
		true,
	);
	throw new Error("factory callback exception was lost");
} catch (error) {
	assert(error === returnedPayload, "normal brand does not suppress factory exceptions");
}
const ReturnedConstructor = function ReturnedConstructor(visit, choose) {
	for (let i = 0; i < 3; i++) visit();
	return choose ? new Map() : 7;
};
function constructReturned(visit, choose) {
	const value = new ReturnedConstructor(visit, choose);
	return Map.prototype.has.call(value, escapedKey);
}
globalThis.__mal_construct_returned = constructReturned;
assert(
	constructReturned(() => {}, true) === false,
	"constructor returns its explicit Map",
);
try {
	constructReturned(() => {}, false);
	throw new Error("constructor substitution lost receiver validation");
} catch (error) {
	assert(
		error instanceof TypeError,
		"primitive constructor return substitutes its ordinary receiver",
	);
}

console.log("exact-collection-receiver PASS");
