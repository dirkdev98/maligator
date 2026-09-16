"use strict";

let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error("collection-direct failure: " + name);
	checks++;
}

const map = new Map();
const set = new Set();
let sum = 0;
for (let i = 0; i < 3000; i++) {
	const key = "key-" + (i % 128);
	const previous = map.get(key) ?? 0;
	ok("map set return " + i, map.set(key, previous + 1) === map);
	ok("set add return " + i, set.add(key) === set);
	sum += map.get(key);
}
ok("direct collection values", sum > 0 && map.size === 128 && set.size === 128);

const scalarMap = new Map([["hit", 1]]);
const scalarSet = new Set(["hit"]);
const scalarMiss = {};
let scalarScore = 0;
for (let i = 0; i < 4000; i++) {
	if (scalarMap.has("hit")) scalarScore++;
	if (!scalarMap.delete(scalarMiss)) scalarScore++;
	if (scalarSet.has("hit")) scalarScore++;
	if (!scalarSet.delete(scalarMiss)) scalarScore++;
}
ok("direct scalar collection operations", scalarScore === 16000);

const entryMap = new Map([
	[1, 2],
	[3, 4],
]);
let entryTotal = 0;
for (const [key, value] of entryMap) entryTotal += key + value;
ok("virtual Map entry pairs", entryTotal === 10);

const entrySet = new Set([3, 5]);
let setEntryTotal = 0;
for (const [first, second] of entrySet.entries()) setEntryTotal += first + second;
ok("Set entry pair semantics", setEntryTotal === 16);

const originalMap = Map;
let replacementEntryTotal = 0;
try {
	globalThis.Map = function () {
		return {
			*[Symbol.iterator]() {
				yield [5, 7];
			},
		};
	};
	for (const [key, value] of new Map()) replacementEntryTotal += key + value;
} finally {
	globalThis.Map = originalMap;
}
ok(
	"replaced Map constructor uses ordinary iterator protocol",
	replacementEntryTotal === 12,
);

function privateFreshMapGet(key) {
	const values = new Map();
	values.set("answer", 42);
	return values.get(key);
}
ok("locked private Map.get", privateFreshMapGet("answer") === 42);

const iteratedMutationMap = new Map();
for (let i = 0; i < 64; i++) iteratedMutationMap.set(i, i);
const mutationIterator = iteratedMutationMap.keys();
ok("iterator starts before mutation", mutationIterator.next().value === 0);
for (let i = 1; i < 49; i++) iteratedMutationMap.delete(i);
iteratedMutationMap.set(64, 64);
const mutationRemainder = [];
for (const value of mutationIterator) mutationRemainder.push(value);
ok(
	"active iterator survives tombstones and sees later insert",
	mutationRemainder.join(",") === "49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64",
);

const clearedDuringIteration = new Map([
	["old-a", 1],
	["old-b", 2],
]);
const clearIterator = clearedDuringIteration.keys();
ok("clear iterator starts", clearIterator.next().value === "old-a");
clearedDuringIteration.clear();
clearedDuringIteration.set("new", 3);
const afterClear = clearIterator.next();
ok(
	"active iterator observes insertion after clear",
	afterClear.value === "new" && clearIterator.next().done === true,
);

const forEachMutation = new Map();
for (let i = 0; i < 32; i++) forEachMutation.set(i, i);
const forEachSeen = [];
forEachMutation.forEach(function (value, key) {
	forEachSeen.push(value);
	if (key === 0) {
		for (let i = 1; i < 25; i++) forEachMutation.delete(i);
		forEachMutation.set(32, 32);
	}
});
ok(
	"forEach mutation keeps insertion-order cursor stable",
	forEachSeen.join(",") === "0,25,26,27,28,29,30,31,32",
);

const defaults = new Map();
ok("missing get argument", defaults.get() === undefined);
ok("missing set arguments", defaults.set() === defaults && defaults.get() === undefined);
const defaultSet = new Set();
ok("missing add argument", defaultSet.add() === defaultSet && defaultSet.has(undefined));

const special = new Map();
special.set(NaN, "nan");
special.set(-0, "zero");
ok(
	"Map key canonicalization",
	special.get(Number("nan")) === "nan" && special.get(0) === "zero",
);

function exerciseNumericCollections(limit) {
	const numericMap = new Map();
	const numericSet = new Set();
	for (let key = 0; key < limit; key++) {
		numericMap.set(key, { key });
		numericSet.add(key);
	}
	for (let key = 0; key < limit; key++) {
		ok("numeric Map get " + key, numericMap.get(key).key === key);
		ok("numeric collection has " + key, numericMap.has(key) && numericSet.has(key));
	}
	for (let key = 1; key < limit; key += 2) {
		ok(
			"numeric collection delete " + key,
			numericMap.delete(key) && numericSet.delete(key),
		);
	}
	numericMap.set(-0, "zero");
	numericSet.add(-0);
	ok("numeric zero normalization", numericMap.get(0) === "zero" && numericSet.has(0));
	numericMap.set(0 / 0, "nan");
	numericSet.add(0 / 0);
	ok(
		"numeric NaN equality",
		numericMap.get(Number.NaN) === "nan" && numericSet.has(Number.NaN),
	);
	numericMap.set(0.5, "fraction");
	numericSet.add(0.5);
	ok(
		"numeric fractional keys",
		numericMap.get(0.5) === "fraction" && numericSet.has(0.5),
	);
	return numericMap.size === numericSet.size;
}
ok("numeric collection operations", exerciseNumericCollections(32));

const plain = {
	value: 1,
	get(key) {
		return this.value + key;
	},
	set(key, value) {
		this[key] = value;
		return "plain-set";
	},
	add(value) {
		this.value += value;
		return "plain-add";
	},
	has(value) {
		return value === this.value;
	},
	delete(value) {
		this.deleted = value;
		return "plain-delete";
	},
};
ok("plain get fallback", plain.get(2) === 3);
ok("plain set fallback", plain.set("stored", 4) === "plain-set" && plain.stored === 4);
ok("plain add fallback", plain.add(5) === "plain-add" && plain.value === 6);
ok("plain has fallback", plain.has(6));
ok("plain delete fallback", plain.delete(7) === "plain-delete" && plain.deleted === 7);

const ownMap = new Map([["key", 1]]);
ownMap.get = function (key) {
	return "own-" + key;
};
ownMap.set = function (key, value) {
	this.own = key + value;
	return "own-set";
};
ownMap.has = function (key) {
	return "own-has-" + key;
};
ownMap.delete = function (key) {
	return "own-delete-" + key;
};
ok("own Map.get fallback", ownMap.get("key") === "own-key");
ok("own Map.set fallback", ownMap.set("k", 2) === "own-set" && ownMap.own === "k2");
ok("own Map.has fallback", ownMap.has("key") === "own-has-key");
ok("own Map.delete fallback", ownMap.delete("key") === "own-delete-key");

const ownSet = new Set();
ownSet.add = function (value) {
	this.own = value;
	return "own-add";
};
ownSet.has = function (value) {
	return "own-has-" + value;
};
ownSet.delete = function (value) {
	return "own-delete-" + value;
};
ok("own Set.add fallback", ownSet.add(3) === "own-add" && ownSet.own === 3);
ok("own Set.has fallback", ownSet.has(3) === "own-has-3");
ok("own Set.delete fallback", ownSet.delete(3) === "own-delete-3");

const intrinsicGet = Map.prototype.get;
Map.prototype.get = function (key) {
	return "prototype-" + key;
};
const overriddenMap = new Map();
ok("Map prototype override", overriddenMap.get("key") === "prototype-key");
Map.prototype.get = intrinsicGet;

const intrinsicAdd = Set.prototype.add;
Set.prototype.add = function (value) {
	this.overridden = value;
	return "prototype-add";
};
const overriddenSet = new Set();
ok(
	"Set prototype override",
	overriddenSet.add(7) === "prototype-add" && overriddenSet.overridden === 7,
);
Set.prototype.add = intrinsicAdd;

const intrinsicMapHas = Map.prototype.has;
Map.prototype.has = function (key) {
	return key === "prototype-hit";
};
ok("Map has prototype override", new Map().has("prototype-hit"));
Map.prototype.has = intrinsicMapHas;

const intrinsicMapDelete = Map.prototype.delete;
Map.prototype.delete = function (key) {
	return key === "prototype-delete";
};
ok("Map delete prototype override", new Map().delete("prototype-delete"));
Map.prototype.delete = intrinsicMapDelete;

const intrinsicSetHas = Set.prototype.has;
Set.prototype.has = function (key) {
	return key === "prototype-hit";
};
ok("Set has prototype override", new Set().has("prototype-hit"));
Set.prototype.has = intrinsicSetHas;

const intrinsicSetDelete = Set.prototype.delete;
Set.prototype.delete = function (key) {
	return key === "prototype-delete";
};
ok("Set delete prototype override", new Set().delete("prototype-delete"));
Set.prototype.delete = intrinsicSetDelete;

const intrinsicArrayIterator = Array.prototype[Symbol.iterator];
const reversedEntryMap = new Map([["key", "value"]]);
Array.prototype[Symbol.iterator] = function* () {
	yield this[1];
	yield this[0];
};
let reversedEntry = "";
for (const [first, second] of reversedEntryMap) {
	reversedEntry = first + ":" + second;
}
Array.prototype[Symbol.iterator] = intrinsicArrayIterator;
ok("entry-pair materialization fallback", reversedEntry === "value:key");

const mutationMap = new Map([["key", 11]]);
function openGetWithArgumentMutation(collection, key) {
	return collection.get(
		((Map.prototype.get = function () {
			return 99;
		}),
		key),
	);
}
const mutationResult = openGetWithArgumentMutation(mutationMap, "key");
Map.prototype.get = intrinsicGet;
ok("method loaded before argument mutation", mutationResult === 11);

const hasMutationMap = new Map([["key", 1]]);
const hasMutationResult = hasMutationMap.has(
	((Map.prototype.has = function () {
		return false;
	}),
	"key"),
);
Map.prototype.has = intrinsicMapHas;
ok("Map has loaded before argument mutation", hasMutationResult === true);

const deleteMutationSet = new Set(["key"]);
const deleteMutationResult = deleteMutationSet.delete(
	((Set.prototype.delete = function () {
		return false;
	}),
	"key"),
);
Set.prototype.delete = intrinsicSetDelete;
ok(
	"Set delete loaded before argument mutation",
	deleteMutationResult === true && !deleteMutationSet.has("key"),
);

const weakKey = {};
const weak = new WeakMap([[weakKey, 5]]);
ok("WeakMap fallback get", weak.get(weakKey) === 5);
ok("WeakMap fallback set", weak.set(weakKey, 6) === weak && weak.get(weakKey) === 6);

let crossBrandThrows = 0;
for (const invoke of [
	() => Map.prototype.get.call(weak, weakKey),
	() => Map.prototype.has.call(new Set(), weakKey),
	() => Set.prototype.add.call(new WeakSet(), weakKey),
]) {
	try {
		invoke();
	} catch (error) {
		if (error instanceof TypeError) crossBrandThrows++;
	}
}
ok("cross-brand collection fallback", crossBrandThrows === 3);

let proxyThrew = false;
try {
	new Proxy(new Map(), {}).get("key");
} catch (error) {
	proxyThrew = error instanceof TypeError;
}
ok("proxy receiver fallback", proxyThrew);

const gc = globalThis.__mal_collect_garbage;
if (typeof gc === "function") {
	const retainedMap = new Map();
	const retainedSet = new Set();
	for (let i = 0; i < 128; i++) {
		const value = { index: i };
		retainedMap.set(value, { value });
		retainedSet.add(value);
	}
	gc();
	let retained = 0;
	for (const [key, value] of retainedMap) {
		if (retainedSet.has(key) && value.value === key) retained++;
	}
	ok("direct stores survive collection", retained === 128);
}

console.log("collection-direct PASS " + checks + "/" + checks);
