let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function caught(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

var cachedGlobal = 0;
let total = 0;
for (let i = 0; i < 2000; i++) {
	cachedGlobal = i;
	total += cachedGlobal;
}
ok("repeated reads and writes stay observable", cachedGlobal === 1999);
ok("globalThis observes the same property", globalThis.cachedGlobal === 1999);
ok("loop used current values", total === (1999 * 2000) / 2);

var cachedObject = { index: 0 };
for (let i = 0; i < 100; i++) cachedObject = { index: i };
ok("object-valued writes preserve barriers", cachedObject.index === 99);

Object.defineProperty(globalThis, "cachedGlobal", {
	value: 7,
	writable: false,
	configurable: true,
});
ok("descriptor value changes are re-read", cachedGlobal === 7);
function strictStore() {
	"use strict";
	cachedGlobal = 9;
}
ok("strict non-writable store throws", caught(strictStore) instanceof TypeError);
ok(
	"strict top-level non-writable store throws",
	caught(() => {
		cachedGlobal = 8;
	}) instanceof TypeError,
);

let accessorValue = 11;
Object.defineProperty(globalThis, "cachedGlobal", {
	configurable: true,
	get() {
		return accessorValue;
	},
	set(value) {
		accessorValue = value + 1;
	},
});
ok("accessor replacement runs getter", cachedGlobal === 11);
cachedGlobal = 20;
ok("accessor replacement runs setter", accessorValue === 21 && cachedGlobal === 21);

Object.defineProperty(globalThis, "cachedGlobal", {
	value: 30,
	writable: true,
	configurable: true,
});
ok("data replacement is observed", cachedGlobal === 30);
delete globalThis.cachedGlobal;
Object.defineProperty(globalThis, "cachedGlobal", {
	value: 31,
	writable: true,
	configurable: true,
});
ok("deletion and recreation refreshes entry identity", cachedGlobal === 31);

delete globalThis.cachedGlobal;
let inheritedSet = 0;
Object.defineProperty(Object.prototype, "cachedGlobal", {
	configurable: true,
	get() {
		return 40;
	},
	set(value) {
		inheritedSet = value;
	},
});
ok("missing own property falls back to prototype getter", cachedGlobal === 40);
cachedGlobal = 41;
ok("missing own property falls back to prototype setter", inheritedSet === 41);
delete Object.prototype.cachedGlobal;
Object.defineProperty(globalThis, "cachedGlobal", {
	value: 42,
	writable: true,
	configurable: true,
});

const evalResult = eval(
	"var evalAddedGlobal = 1;" +
		"for (let i = 0; i < 1000; i++) evalAddedGlobal = evalAddedGlobal + 1;" +
		"evalAddedGlobal",
);
ok("eval-added string constants and global entries are safe", evalResult === 1001);
ok("eval-added global remains observable", evalAddedGlobal === 1001);
const sloppyStoreResult = (0, eval)(
	"var sloppyCachedGlobal = 5;" +
		"Object.defineProperty(globalThis, 'sloppyCachedGlobal', { writable: false });" +
		"sloppyCachedGlobal = 6;" +
		"sloppyCachedGlobal",
);
ok("sloppy non-writable store is ignored", sloppyStoreResult === 5);

const firstRealm = new ShadowRealm();
const secondRealm = new ShadowRealm();
const firstRead = firstRealm.evaluate(
	"var realmCachedGlobal = 101; () => realmCachedGlobal",
);
const secondRead = secondRealm.evaluate(
	"var realmCachedGlobal = 202; () => realmCachedGlobal",
);
for (let i = 0; i < 100; i++) {
	ok("realm cache identity", firstRead() === 101 && secondRead() === 202);
}
ok("outer realm stays isolated", typeof realmCachedGlobal === "undefined");

ok("checks ran", passed > 0);
console.log("global-property-cache PASS");
