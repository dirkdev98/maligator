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
for (const convert of [
	function (iterator) {
		return new Map(iterator);
	},
	function (iterator) {
		return Object.fromEntries(iterator);
	},
]) {
	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	const sparse = new Array(1);
	Object.setPrototypeOf(sparse, revoked.proxy);
	const iterator = foreign.Array.prototype.entries.call(sparse);
	try {
		convert(iterator);
		throw new Error("missing foreign iterator error");
	} catch (error) {
		if (Object.getPrototypeOf(error) !== foreign.TypeError.prototype)
			throw new Error("wrong iterator error realm");
		iteratorErrors++;
	}
	if (!iterator.next().done) throw new Error("foreign iterator replayed");
}
console.log(
	"constructor-realms",
	closed,
	calls,
	result.get("x"),
	result.get("y"),
	iteratorErrors,
);
