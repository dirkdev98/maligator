"use strict";

const collect = globalThis.__mal_collect_garbage;
if (typeof collect !== "function") throw new Error("weak-storage requires MAL_HOST_GC=1");
let checks = 0;
function check(condition, name) {
	if (!condition) throw new Error(name);
	checks++;
}
function throwsTypeError(action, name) {
	let rejected = false;
	try {
		action();
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	check(rejected, name);
}

for (const count of [0, 1, 2, 3, 4, 5, 16, 80]) {
	const keys = Array.from({ length: count }, (_, i) =>
		i % 2 === 0 ? { index: i } : Symbol("key" + i),
	);
	const map = new WeakMap();
	const set = new WeakSet();
	for (let i = 0; i < keys.length; i++) {
		check(map.set(keys[i], { index: i }) === map, "WeakMap set receiver");
		check(set.add(keys[i]) === set, "WeakSet add receiver");
	}
	collect();
	for (let i = 0; i < keys.length; i++) {
		check(map.get(keys[i]).index === i && set.has(keys[i]), "live keys survive GC");
		map.set(keys[i], { index: i + 100 });
		if (i % 2 === 0) {
			check(map.delete(keys[i]) && set.delete(keys[i]), "remove live identities");
			check(!map.has(keys[i]) && !set.has(keys[i]), "removed identities absent");
			map.set(keys[i], { index: i + 200 });
			set.add(keys[i]);
		}
	}
	for (let round = 0; round < 32; round++) {
		if (keys.length === 0) break;
		const index = round % keys.length;
		check(map.delete(keys[index]) && set.delete(keys[index]), "churn removes old key");
		keys[index] = round % 2 === 0 ? {} : Symbol("replacement" + round);
		map.set(keys[index], { index: round + 1000 });
		set.add(keys[index]);
		collect();
		check(
			map.get(keys[index]).index === round + 1000 && set.has(keys[index]),
			"churn keeps new pair",
		);
	}
	for (const key of keys)
		check(map.has(key) && set.has(key), "survivors remain searchable");
}

const map = new WeakMap();
const set = new WeakSet();
for (const invalid of [
	undefined,
	null,
	false,
	1,
	NaN,
	"key",
	1n,
	Symbol.for("registered"),
]) {
	check(
		map.get(invalid) === undefined && !map.has(invalid) && !map.delete(invalid),
		"invalid WeakMap query",
	);
	check(!set.has(invalid) && !set.delete(invalid), "invalid WeakSet query");
	throwsTypeError(() => map.set(invalid, 1), "invalid WeakMap insertion");
	throwsTypeError(() => set.add(invalid), "invalid WeakSet insertion");
}
const revocable = Proxy.revocable(
	{},
	{
		get() {
			throw new Error("key inspected");
		},
	},
);
map.set(revocable.proxy, { value: 17 });
set.add(revocable.proxy);
revocable.revoke();
collect();
check(
	map.get(revocable.proxy).value === 17 && set.has(revocable.proxy),
	"revoked Proxy identity",
);

const computedKey = {};
let calls = 0;
const computed = map.getOrInsertComputed(computedKey, (key) => {
	calls++;
	check(key === computedKey, "computed callback key");
	map.set(key, { value: "intermediate" });
	for (let i = 0; i < 80; i++) map.set({}, { index: i });
	collect();
	return { value: "computed" };
});
check(
	calls === 1 && computed === map.get(computedKey) && computed.value === "computed",
	"computed insertion re-searches after mutation",
);
check(
	map.getOrInsert(computedKey, "unused") === computed,
	"getOrInsert retains stored value",
);
check(
	map.getOrInsertComputed(computedKey, () => {
		throw new Error("called for present key");
	}) === computed,
	"present computed key skips callback",
);
const undefinedKey = {};
map.set(undefinedKey, undefined);
check(
	map.getOrInsert(undefinedKey, 99) === undefined &&
		map.getOrInsertComputed(undefinedKey, () => {
			throw new Error("called for undefined value");
		}) === undefined,
	"stored undefined remains present",
);
const throwingKey = {};
const failure = {};
let callbackThrew = false;
try {
	map.getOrInsertComputed(throwingKey, (key) => {
		map.set(key, { value: 37 });
		collect();
		throw failure;
	});
} catch (error) {
	callbackThrew = error === failure;
}
check(
	callbackThrew && map.get(throwingKey).value === 37,
	"abrupt callback preserves its mutation",
);
throwsTypeError(
	() => map.getOrInsertComputed(computedKey, 1),
	"computed validates callback before lookup",
);
const proxyKey = Symbol("computed Proxy");
let applyGets = 0;
const proxyResult = map.getOrInsertComputed(
	proxyKey,
	new Proxy(function () {}, {
		get apply() {
			applyGets++;
			collect();
			return (target, receiver, args) => {
				check(args[0] === proxyKey, "Proxy computed argument root");
				return { value: 23 };
			};
		},
	}),
);
check(
	applyGets === 1 && proxyResult === map.get(proxyKey) && proxyResult.value === 23,
	"Proxy computed callback survives GC",
);

const key = {};
const strongMap = new Map();
const strongSet = new Set();
for (const receiver of [strongMap, strongSet, set, {}]) {
	throwsTypeError(
		() => WeakMap.prototype.get.call(receiver, key),
		"WeakMap exact receiver brand",
	);
}
for (const receiver of [strongMap, strongSet, map, {}]) {
	throwsTypeError(
		() => WeakSet.prototype.has.call(receiver, key),
		"WeakSet exact receiver brand",
	);
}
throwsTypeError(() => Map.prototype.set.call(map, key, 1), "Map rejects WeakMap");
throwsTypeError(() => Set.prototype.add.call(set, key), "Set rejects WeakSet");
check(
	Object.prototype.toString.call(map) === "[object WeakMap]" &&
		Object.prototype.toString.call(set) === "[object WeakSet]",
	"weak prototype tags",
);
Object.defineProperty(map, Symbol.toStringTag, {
	get() {
		collect();
		return "CustomWeak";
	},
});
check(
	Object.prototype.toString.call(map) === "[object CustomWeak]",
	"weak own tag getter",
);
map.retained = { value: 31 };
set.retained = { value: 32 };
collect();
check(
	map.retained.value + set.retained.value === 63,
	"weak owners trace ordinary properties",
);
for (const source of [map, set, { nested: map }, [set]]) {
	let rejected = false;
	try {
		structuredClone(source);
	} catch (error) {
		rejected = error.name === "DataCloneError";
	}
	check(rejected, "structuredClone rejects weak owner");
}

for (const Constructor of [WeakMap, WeakSet]) {
	let closed = 0;
	const invalid = {
		[Symbol.iterator]() {
			return {
				next() {
					return { done: false, value: Constructor === WeakMap ? [1, 2] : 1 };
				},
				return() {
					closed++;
					collect();
					return {};
				},
			};
		},
	};
	throwsTypeError(() => new Constructor(invalid), "weak constructor rejects invalid key");
	check(closed === 1, "weak constructor closes iterator");
}
for (const [Constructor, method] of [
	[WeakMap, "set"],
	[WeakSet, "add"],
]) {
	const prototype = Object.create(Constructor.prototype);
	let additions = 0;
	Object.defineProperty(prototype, method, {
		value(member, value) {
			additions++;
			check(
				member === key && (method === "add" || value === 41),
				"custom weak adder arguments",
			);
			collect();
		},
	});
	function Target() {}
	Target.prototype = prototype;
	const instance = Reflect.construct(
		Constructor,
		[method === "set" ? [[key, 41]] : [key]],
		Target,
	);
	check(
		additions === 1 && !Constructor.prototype.has.call(instance, key),
		"weak constructor captures custom adder",
	);
}

console.log("weak-storage PASS " + checks + "/" + checks);
