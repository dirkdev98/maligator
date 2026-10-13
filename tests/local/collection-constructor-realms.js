"use strict";
const foreign = $262.createRealm().global;
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
function construct(Base, prototype, method, adder, source) {
	function Derived() {}
	Derived.prototype = Object.create(prototype, { [method]: { value: adder } });
	return Reflect.construct(Base, [source], Derived);
}
let closed = 0;
for (const [Base, prototype, method, adder, value] of [
	[WeakMap, WeakMap.prototype, "set", foreign.WeakMap.prototype.set, [1, 2]],
	[WeakSet, WeakSet.prototype, "add", foreign.WeakSet.prototype.add, 1],
]) {
	const source = {
		[Symbol.iterator]() {
			return {
				next() {
					collectGarbage();
					return { value, done: false };
				},
				return() {
					closed++;
					collectGarbage();
					return {};
				},
			};
		},
	};
	try {
		construct(Base, prototype, method, adder, source);
		throw new Error("missing weak rejection");
	} catch (error) {
		if (Object.getPrototypeOf(error) !== foreign.TypeError.prototype)
			throw new Error("wrong adder error realm");
	}
}
let calls = 0;
function localAdder(key, value) {
	collectGarbage();
	if (
		Object.getPrototypeOf(Object.getPrototypeOf(this)) !== foreign.Map.prototype ||
		arguments.length !== 2
	)
		throw new Error("foreign constructor receiver");
	calls++;
	Map.prototype.set.call(this, key, value);
}
const result = construct(foreign.Map, foreign.Map.prototype, "set", localAdder, [
	["x", 7],
	["y", 8],
]);
if (closed !== 2 || calls !== 2 || result.get("y") !== 8)
	throw new Error("realm completion");
let iteratorErrors = 0;
for (const [label, convert] of [
	[
		"Map",
		function (iterator) {
			return new Map(iterator);
		},
	],
	[
		"fromEntries",
		function (iterator) {
			return Object.fromEntries(iterator);
		},
	],
]) {
	for (const maker of [Array, foreign.Array]) {
		for (const nextRealm of [globalThis, foreign]) {
			const revoked = Proxy.revocable({}, {});
			revoked.revoke();
			const sparse = new Array(1);
			Object.setPrototypeOf(sparse, revoked.proxy);
			const iterator = maker.prototype.entries.call(sparse);
			const next = Object.getPrototypeOf(nextRealm.Array.prototype.entries.call([])).next;
			Object.defineProperty(iterator, "next", { value: next });
			try {
				convert(iterator);
				throw new Error("missing iterator error " + label);
			} catch (error) {
				if (Object.getPrototypeOf(error) !== nextRealm.TypeError.prototype)
					throw new Error("wrong iterator error realm " + label);
				iteratorErrors++;
			}
			if (!iterator.next().done) throw new Error("iterator replayed " + label);
			if (Object.getPrototypeOf([]) !== Array.prototype)
				throw new Error("iterator throw leaked realm " + label);
		}
	}
}
function mapPairs(next, expectedPrototype) {
	const collection = new Map([["map", 7]]);
	Object.defineProperty(collection, Symbol.iterator, {
		value() {
			const iterator = Map.prototype.entries.call(this);
			Object.defineProperty(iterator, "next", { value: next });
			return iterator;
		},
	});
	let total = 0;
	for (const pair of collection) {
		collectGarbage();
		if (Object.getPrototypeOf(pair) !== expectedPrototype || pair[0] !== "map")
			throw new Error("Map entry pair realm");
		if (Object.getPrototypeOf([]) !== Array.prototype)
			throw new Error("Map next leaked realm");
		total += pair[1];
	}
	return total;
}
function setPairs(next, expectedPrototype) {
	const collection = new Set([9]);
	Object.defineProperty(collection, Symbol.iterator, {
		value() {
			const iterator = Set.prototype.entries.call(this);
			Object.defineProperty(iterator, "next", { value: next });
			return iterator;
		},
	});
	let total = 0;
	for (const pair of collection) {
		collectGarbage();
		if (Object.getPrototypeOf(pair) !== expectedPrototype || pair[0] !== pair[1])
			throw new Error("Set entry pair realm");
		if (Object.getPrototypeOf([]) !== Array.prototype)
			throw new Error("Set next leaked realm");
		total += pair[0];
	}
	return total;
}
let entryTotal = 0;
for (const realm of [globalThis, foreign]) {
	entryTotal += mapPairs(new realm.Map().entries().next, realm.Array.prototype);
	entryTotal += setPairs(new realm.Set().entries().next, realm.Array.prototype);
	for (const [iterator, first, second] of [
		[new Map([["generic", 11]]).entries(), "generic", 11],
		[new Set([13]).entries(), 13, 13],
		[[17].entries(), 0, 17],
	]) {
		const next =
			typeof first === "string"
				? new realm.Map().entries().next
				: first === 13
					? new realm.Set().entries().next
					: realm.Array.prototype.entries.call([]).next;
		Object.defineProperty(iterator, "next", { value: next });
		const pair = Array.from(iterator)[0];
		collectGarbage();
		if (
			Object.getPrototypeOf(pair) !== realm.Array.prototype ||
			pair[0] !== first ||
			pair[1] !== second
		)
			throw new Error("generic entry pair realm");
		entryTotal += pair[1];
	}
}
console.log(
	"constructor-realms",
	closed,
	calls,
	result.get("x"),
	result.get("y"),
	iteratorErrors,
	entryTotal,
);
