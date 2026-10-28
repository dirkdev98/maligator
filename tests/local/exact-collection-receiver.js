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

	readCaptured(visit, key) {
		const first = Map.prototype.get.call(this.#map, key);
		visit();
		return [first, Map.prototype.get.call(this.#map, key)];
	}

	replaceMap() {
		this.#map = new Map([["answer", { value: 84 }]]);
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

const replacedRegistry = new Registry();
const replacementRead = replacedRegistry.readCaptured(() => {
	replacedRegistry.replaceMap();
	if (typeof collect === "function") collect();
}, "answer");
assert(
	replacementRead[0].value === 42 && replacementRead[1].value === 84,
	"private collection reads observe replacement while their brand stays stable",
);

function readGlobalCaptured(visit, key) {
	const first = Map.prototype.get.call(globalMap, key);
	visit(globalMap);
	return [first, Map.prototype.get.call(globalMap, key), globalMap.get(key)];
}
const globalReplacement = { value: "replaced" };
const globalRead = readGlobalCaptured((map) => {
	map.set("global", globalReplacement);
	map.get = () => "shadowed";
	if (typeof collect === "function") collect();
}, "global");
assert(
	globalRead[0] === 9 &&
		globalRead[1] === globalReplacement &&
		globalRead[2] === "shadowed",
	"global collection reads retain mutation and method lookup effects",
);

const weakKey = {
	[Symbol.toPrimitive]() {
		throw new Error("weak key was coerced");
	},
};
function freshWeakRead(key) {
	const map = new WeakMap([[key, { marker: "fresh weak value" }]]);
	return map.get(key);
}
function freshWeakHas(key) {
	const set = new WeakSet();
	return set.has(key);
}
let weakMutationCompletions = 0;
function freshWeakWrite(key, value) {
	const map = new WeakMap();
	const result = map.set(key, value);
	weakMutationCompletions++;
	return result;
}
function freshWeakAdd(key) {
	const set = new WeakSet();
	const result = set.add(key);
	weakMutationCompletions++;
	return result;
}
Object.assign(globalThis, { freshWeakRead, freshWeakHas, freshWeakWrite, freshWeakAdd });
assert(freshWeakRead(weakKey).marker === "fresh weak value", "fresh weak read");
assert(!freshWeakHas(weakKey), "fresh weak membership");
class WeakRegistry {
	#map = new WeakMap([[weakKey, { marker: "weak value" }]]);
	#set = new WeakSet([weakKey]);

	read(key) {
		return this.#map.get(key);
	}

	has(key) {
		return this.#map.has(key) && this.#set.has(key);
	}

	write(key, value) {
		const result = this.#map.set(key, value);
		weakMutationCompletions++;
		return result === this.#map;
	}

	add(key) {
		const result = this.#set.add(key);
		weakMutationCompletions++;
		return result === this.#set;
	}

	shadowedWrite(result) {
		this.#map.set = () => result;
		return this.#map.set(weakKey, {});
	}

	crossBrandWrite() {
		this.#map.set = Map.prototype.set;
		return this.#map.set(weakKey, {});
	}

	remove(key) {
		return this.#map.delete(key) && this.#set.delete(key);
	}

	crossBrand() {
		this.#map.has = Map.prototype.has;
		try {
			this.#map.has(weakKey);
			return false;
		} catch (error) {
			return error instanceof TypeError;
		}
	}

	shadowedHas(value) {
		this.#set.has = () => value;
		return this.#set.has(weakKey);
	}

	shadowedDelete(value) {
		this.#map.delete = () => value;
		return this.#map.delete(weakKey);
	}

	captured(visit, key) {
		const map = this.#map;
		visit(map);
		return [WeakMap.prototype.get.call(map, key), map.get(key)];
	}
}
const weakRegistry = new WeakRegistry();
const insertedWeakKey = {};
const insertedWeakValue = { marker: "inserted weak value" };
assert(
	weakRegistry.write(insertedWeakKey, insertedWeakValue),
	"weak set returns its receiver",
);
assert(weakRegistry.add(insertedWeakKey), "weak add returns its receiver");
assert(weakRegistry.has(insertedWeakKey), "weak insertion changes membership");
assert(
	weakRegistry.read(insertedWeakKey) === insertedWeakValue,
	"weak set retains its value",
);
assert(
	freshWeakWrite(weakKey, insertedWeakValue).get(weakKey) === insertedWeakValue,
	"fresh weak set",
);
assert(freshWeakAdd(weakKey).has(weakKey), "fresh weak add");
const weakDefaultValue = freshWeakWrite(weakKey);
assert(
	weakDefaultValue.has(weakKey) && weakDefaultValue.get(weakKey) === undefined,
	"weak set defaults an omitted value to undefined",
);
const weakSymbol = Symbol("local weak key");
assert(
	weakRegistry.write(weakSymbol, insertedWeakValue),
	"weak set accepts an unregistered Symbol",
);
assert(weakRegistry.add(weakSymbol), "weak add accepts an unregistered Symbol");
for (const invalidKey of [1, undefined, Symbol.for("registered mutator key")]) {
	for (const mutate of [
		() => weakRegistry.write(invalidKey, insertedWeakValue),
		() => weakRegistry.add(invalidKey),
		() => freshWeakWrite(invalidKey, insertedWeakValue),
		() => freshWeakAdd(invalidKey),
	]) {
		const completed = weakMutationCompletions;
		try {
			mutate();
			throw new Error("missing weak mutator key error");
		} catch (error) {
			assert(error instanceof TypeError, "weak mutator retains its key error");
		}
		assert(
			weakMutationCompletions === completed,
			"throwing weak mutator skips its continuation",
		);
	}
}
assert(
	new WeakRegistry().shadowedWrite(insertedWeakValue) === insertedWeakValue,
	"weak mutator keeps a shadowed callee result",
);
try {
	new WeakRegistry().crossBrandWrite();
	throw new Error("missing weak mutator cross-brand error");
} catch (error) {
	assert(error instanceof TypeError, "weak mutator retains cross-brand errors");
}
assert(weakRegistry.read(weakKey).marker === "weak value", "weak private value");
assert(weakRegistry.has(weakKey), "weak private membership");
if (typeof collect === "function") collect();
assert(
	weakRegistry.read(weakKey).marker === "weak value",
	"weak value survives with its live key",
);
assert(new WeakRegistry().crossBrand(), "weak receiver keeps cross-brand callee errors");
const weakCalleeResult = { marker: "weak fallback result" };
assert(
	new WeakRegistry().shadowedHas(weakCalleeResult) === weakCalleeResult,
	"weak membership fallback keeps arbitrary results",
);
assert(
	new WeakRegistry().shadowedDelete(weakCalleeResult) === weakCalleeResult,
	"weak deletion fallback keeps arbitrary results",
);
function readDetachedWeakValue() {
	const registry = new WeakRegistry();
	const value = registry.read(weakKey);
	registry.remove(weakKey);
	globalThis.weakAllocationFence = {};
	if (typeof collect === "function") collect();
	return value.marker;
}
assert(
	readDetachedWeakValue() === "weak value",
	"weak read result stays rooted after deletion",
);
for (const key of [undefined, null, 1, "key", 1n, Symbol.for("registered weak key")]) {
	assert(weakRegistry.read(key) === undefined, "invalid weak read is empty");
	assert(!weakRegistry.has(key), "invalid weak membership is false");
	assert(!weakRegistry.remove(key), "invalid weak deletion is false");
}
const weakReplacement = { marker: "replacement weak value" };
const weakRead = weakRegistry.captured((map) => {
	map.set(weakKey, weakReplacement);
	map.get = () => "shadowed weak method";
	if (typeof collect === "function") collect();
}, weakKey);
assert(weakRead[0] === weakReplacement, "weak captured read observes content writes");
assert(weakRead[1] === "shadowed weak method", "weak loaded callee retains shadowing");
assert(weakRegistry.remove(weakKey), "weak deletion mutates membership");
assert(!weakRegistry.has(weakKey), "weak deletion remains observable");

function guardedWeakRead(map, key, visit) {
	const method = map.get;
	visit(map);
	return method.call(map, key);
}
const capturedWeakValue = { marker: "captured weak value" };
const changingWeakMap = new WeakMap([[weakKey, capturedWeakValue]]);
assert(
	guardedWeakRead(changingWeakMap, weakKey, (map) => {
		map.get = () => "later method";
	}) === capturedWeakValue,
	"weak method capture precedes argument effects",
);
for (const [receiver, method] of [
	[new Proxy(new WeakMap(), {}), WeakMap.prototype.get],
	[new Proxy(new WeakMap(), {}), WeakMap.prototype.set],
	[new Proxy(new WeakSet(), {}), WeakSet.prototype.add],
	[new Map(), WeakMap.prototype.get],
	[new WeakSet(), WeakMap.prototype.get],
	[new WeakMap(), WeakSet.prototype.has],
	[new Set(), WeakSet.prototype.has],
]) {
	try {
		method.call(receiver, weakKey);
		throw new Error("missing weak receiver error");
	} catch (error) {
		assert(error instanceof TypeError, "weak receiver errors retain their class");
	}
}
function* suspendedWeakRead(map, key) {
	yield map;
	return map.get(key);
}
const weakIterator = suspendedWeakRead(
	new WeakMap([[weakKey, { marker: "yielded weak value" }]]),
	weakKey,
);
weakIterator.next().value.get = () => "resumed weak method";
if (typeof collect === "function") collect();
assert(
	weakIterator.next().value === "resumed weak method",
	"weak callee changes across yield",
);

function weakPrimitiveGet(receiver, key, visit) {
	const value = WeakMap.prototype.get.call(receiver, +key, visit());
	return typeof value === "undefined" ? 17 : 11;
}
function weakPrimitivePredicates(map, set, input) {
	const key = +input;
	return WeakMap.prototype.has.call(map, key) ||
		WeakMap.prototype.delete.call(map, key) ||
		WeakSet.prototype.has.call(set, key) ||
		WeakSet.prototype.delete.call(set, key)
		? 11
		: 17;
}
function weakSpreadGet(receiver, input, tail) {
	return WeakMap.prototype.get.call(receiver, +input, ...tail) === undefined ? 17 : 11;
}
function weakOpaqueSpreadGet(tail) {
	return WeakMap.prototype.get.call(...tail);
}
function weakListGet(receiver, list) {
	return WeakMap.prototype.get.apply(receiver, list);
}
function weakPrimitiveSet(receiver, input) {
	return WeakMap.prototype.set.call(receiver, +input, {}) === receiver;
}
Object.assign(globalThis, {
	weakPrimitiveGet,
	weakPrimitivePredicates,
	weakSpreadGet,
	weakOpaqueSpreadGet,
	weakListGet,
	weakPrimitiveSet,
});
const weakCallOrder = [];
const primitiveWeakKey = {
	valueOf() {
		weakCallOrder.push("key");
		return 1;
	},
};
const visitWeakPrimitive = () => weakCallOrder.push("extra");
assert(
	weakPrimitiveGet(new WeakMap(), primitiveWeakKey, visitWeakPrimitive) === 17,
	"weak primitive read has an undefined normal result",
);
assert(weakCallOrder.join(",") === "key,extra", "weak read retains argument effects");
assert(
	weakPrimitivePredicates(new WeakMap(), new WeakSet(), "1") === 17,
	"weak primitive predicates have false normal results",
);
weakCallOrder.length = 0;
try {
	weakPrimitiveGet({}, primitiveWeakKey, visitWeakPrimitive);
	throw new Error("missing weak primitive receiver error");
} catch (error) {
	assert(error instanceof TypeError, "weak primitive result retains receiver validation");
}
assert(
	weakCallOrder.join(",") === "key,extra",
	"weak receiver failure follows argument effects",
);
const weakArgumentError = {};
let weakExtraCalls = 0;
try {
	weakPrimitiveGet(
		{},
		{
			valueOf() {
				throw weakArgumentError;
			},
		},
		() => weakExtraCalls++,
	);
	throw new Error("missing weak key coercion error");
} catch (error) {
	assert(
		error === weakArgumentError,
		"weak key coercion error precedes receiver failure",
	);
}
assert(weakExtraCalls === 0, "weak key failure skips later arguments");
try {
	weakPrimitiveGet({}, 1, () => {
		throw weakArgumentError;
	});
	throw new Error("missing weak extra argument error");
} catch (error) {
	assert(
		error === weakArgumentError,
		"weak extra argument error precedes receiver failure",
	);
}

const weakTail = {
	*[Symbol.iterator]() {
		weakCallOrder.push("tail");
		yield 2;
	},
};
weakCallOrder.length = 0;
assert(
	weakSpreadGet(new WeakMap(), primitiveWeakKey, weakTail) === 17,
	"weak spread retains a fixed primitive key",
);
assert(weakCallOrder.join(",") === "key,tail", "weak spread consumes ignored arguments");
try {
	weakSpreadGet({}, 1, {
		[Symbol.iterator]() {
			throw weakArgumentError;
		},
	});
	throw new Error("missing weak iterable argument error");
} catch (error) {
	assert(error === weakArgumentError, "weak iterable error precedes receiver failure");
}
const listWeakMap = new WeakMap([[weakKey, capturedWeakValue]]);
assert(
	weakOpaqueSpreadGet([listWeakMap, weakKey]) === capturedWeakValue,
	"weak spread with an unknown receiver retains list elements",
);
assert(
	weakListGet(listWeakMap, [weakKey]) === capturedWeakValue,
	"weak array-like key retains a possible hit",
);
try {
	weakPrimitiveSet(new WeakMap(), 1);
	throw new Error("missing weak primitive mutator error");
} catch (error) {
	assert(error instanceof TypeError, "weak mutator without a normal result still throws");
}

const registeredWeakRecord = function registeredWeakRecord(input, visit) {
	for (let i = 0; i < 3; i++) visit();
	return { key: Symbol.for(input) };
};
const holdableWeakRecord = function holdableWeakRecord(input, useObject, visit) {
	for (let i = 0; i < 3; i++) visit();
	return { key: useObject ? {} : Symbol(input) };
};
function holdableWeakRoundTrip(input, useObject, visit) {
	const map = new WeakMap();
	const set = new WeakSet();
	const { key } = holdableWeakRecord(input, useObject, visit);
	visit(map, set);
	const mapAlias = WeakMap.prototype.set.call(map, key, input) === map;
	const setAlias = set.add(key) === set;
	visit(map, set);
	return mapAlias && setAlias && map.get(key) === input && set.has(key);
}
globalThis.holdableWeakRoundTrip = holdableWeakRoundTrip;
for (const useObject of [false, true])
	assert(
		holdableWeakRoundTrip({ marker: "retained weak payload" }, useObject, () => {
			if (typeof collect === "function") collect();
		}),
		"holdable key returned in a record retains aliases and payload through GC",
	);
function registeredWeakRead(receiver, input, visit) {
	const { key } = registeredWeakRecord(input, visit);
	const value = WeakMap.prototype.get.call(receiver, key);
	return typeof value === "undefined" ? 17 : 11;
}
function registeredKeyLength(input, visit) {
	return Symbol.keyFor(registeredWeakRecord(input, visit).key).length;
}
function symbolCategory(key) {
	return typeof key === "symbol" && !!key;
}
Object.assign(globalThis, { registeredWeakRead, registeredKeyLength, symbolCategory });
const registrationOrder = [];
const registryInput = {
	toString() {
		registrationOrder.push("key");
		return "registered weak key";
	},
};
const visitRegistration = () => registrationOrder.push("visit");
assert(
	registeredWeakRead(new WeakMap(), registryInput, visitRegistration) === 17,
	"registered Symbol returned in a record cannot hit a weak lookup",
);
assert(
	registrationOrder.join(",") === "visit,visit,visit,key",
	"registered Symbol fact retains factory and coercion effects",
);
assert(
	registeredKeyLength("registered weak key", visitRegistration) === 19,
	"registry key returned by a call has a String length",
);
for (const key of [Symbol("local"), Symbol.for("registered")])
	assert(symbolCategory(key), "both Symbol subkinds remain truthy Symbols");
assert(!symbolCategory({}), "Object remains outside the Symbol category");
try {
	registeredWeakRead(new Proxy(new WeakMap(), {}), "registered", visitRegistration);
	throw new Error("missing registered weak receiver error");
} catch (error) {
	assert(error instanceof TypeError, "impossible weak hit retains receiver validation");
}

if (typeof $262 === "object") {
	const foreign = $262.createRealm().global;
	for (const [receiver, method, ErrorClass] of [
		[new WeakMap(), foreign.WeakMap.prototype.set, foreign.TypeError],
		[new WeakSet(), foreign.WeakSet.prototype.add, foreign.TypeError],
		[new foreign.WeakMap(), WeakMap.prototype.set, TypeError],
		[new foreign.WeakSet(), WeakSet.prototype.add, TypeError],
	]) {
		try {
			method.call(receiver, 1, insertedWeakValue);
			throw new Error("missing borrowed weak mutator error");
		} catch (error) {
			assert(
				Object.getPrototypeOf(error) === ErrorClass.prototype,
				"weak key error belongs to the callee realm",
			);
		}
	}
}

console.log("exact-collection-receiver PASS");
