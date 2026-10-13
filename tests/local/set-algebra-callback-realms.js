"use strict";
const foreign = $262.createRealm().global;
const collectGarbage =
	globalThis.__mal_collect_garbage ?? globalThis.$262?.gc ?? globalThis.gc ?? (() => {});
let calls = 0;
const other = {
	size: 100,
	has(value) {
		collectGarbage();
		if (this !== other || arguments.length !== 1)
			throw new Error("realm callback receiver/arity");
		calls++;
		return value === 2;
	},
	keys() {
		throw new Error("unused keys");
	},
};
const result = foreign.Set.prototype.intersection.call(new Set([1, 2, 3]), other);
if (
	Object.getPrototypeOf(result) !== foreign.Set.prototype ||
	result.size !== 1 ||
	!result.has(2) ||
	calls !== 3
)
	throw new Error("foreign result prototype/local callback");
const marker = { marker: true };
let thrown = false;
try {
	foreign.Set.prototype.difference.call(new Set([1]), {
		size: 10,
		has() {
			collectGarbage();
			throw marker;
		},
		keys() {},
	});
} catch (error) {
	if (error !== marker) throw new Error("foreign callback completion");
	thrown = true;
}
if (!thrown) throw new Error("missing callback throw");
let wrongBrand = false;
try {
	new Set([1]).isSubsetOf({
		size: 1,
		has: foreign.Set.prototype.has,
		keys: foreign.Set.prototype.keys,
	});
} catch (error) {
	wrongBrand = Object.getPrototypeOf(error) === foreign.TypeError.prototype;
}
if (!wrongBrand) throw new Error("borrowed has error realm");
console.log("set-algebra-realms", calls, result.size, thrown, wrongBrand);
