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
};
ok("plain get fallback", plain.get(2) === 3);
ok("plain set fallback", plain.set("stored", 4) === "plain-set" && plain.stored === 4);
ok("plain add fallback", plain.add(5) === "plain-add" && plain.value === 6);

const ownMap = new Map([["key", 1]]);
ownMap.get = function (key) {
	return "own-" + key;
};
ownMap.set = function (key, value) {
	this.own = key + value;
	return "own-set";
};
ok("own Map.get fallback", ownMap.get("key") === "own-key");
ok("own Map.set fallback", ownMap.set("k", 2) === "own-set" && ownMap.own === "k2");

const ownSet = new Set();
ownSet.add = function (value) {
	this.own = value;
	return "own-add";
};
ok("own Set.add fallback", ownSet.add(3) === "own-add" && ownSet.own === 3);

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

const mutationMap = new Map([["key", 11]]);
const mutationResult = mutationMap.get(
	((Map.prototype.get = function () {
		return 99;
	}),
	"key"),
);
Map.prototype.get = intrinsicGet;
ok("method loaded before argument mutation", mutationResult === 11);

const weakKey = {};
const weak = new WeakMap([[weakKey, 5]]);
ok("WeakMap fallback get", weak.get(weakKey) === 5);
ok("WeakMap fallback set", weak.set(weakKey, 6) === weak && weak.get(weakKey) === 6);

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
