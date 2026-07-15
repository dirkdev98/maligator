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

const namedSelfShadow = function namedSelfShadow() {
	var namedSelfShadow;
	return namedSelfShadow;
};
ok("var shadows named function expression self binding", namedSelfShadow() === undefined);
const namedSelfParameter = function namedSelfParameter(namedSelfParameter) {
	namedSelfParameter = 1;
	return namedSelfParameter;
};
ok(
	"parameter shadows named function expression self binding",
	namedSelfParameter() === 1,
);
const argumentsParameterResult = (0, eval)(
	"(function(arguments = 1){ var arguments; return arguments; })()",
);
ok("body var copies default parameter value", argumentsParameterResult === 1);

function readInheritedValue(object) {
	return object.cached;
}
const inheritedReceiver = Object.create({ cached: 1 });
const missingReceiver = {};
ok("inherited IC hit", readInheritedValue(inheritedReceiver) === 1);
ok(
	"inherited IC mode does not alias an own-shape cache",
	readInheritedValue(missingReceiver) === undefined,
);

Object.defineProperty(globalThis, "cachedGlobal", {
	value: 7,
	writable: false,
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

let functionSetterCalls = 0;
Object.defineProperty(globalThis, "evalFunctionGlobal", {
	configurable: true,
	set() {
		functionSetterCalls++;
	},
});
(0, eval)("function evalFunctionGlobal(){ return 42 }");
const evalFunctionDesc = Object.getOwnPropertyDescriptor(
	globalThis,
	"evalFunctionGlobal",
);
ok(
	"eval function replaces configurable accessor",
	functionSetterCalls === 0 &&
		typeof evalFunctionDesc.value === "function" &&
		evalFunctionDesc.configurable === true &&
		evalFunctionGlobal() === 42,
);

Object.defineProperty(globalThis, "blockedFunctionGlobal", {
	value: 1,
	writable: false,
	enumerable: true,
	configurable: false,
});
delete globalThis.uninstalledFunctionGlobal;
const blockedDeclaration = caught(() =>
	(0, eval)("function uninstalledFunctionGlobal(){} function blockedFunctionGlobal(){}"),
);
ok(
	"invalid global function declaration throws",
	blockedDeclaration instanceof SyntaxError,
);
ok(
	"global function checks precede installation",
	!("uninstalledFunctionGlobal" in globalThis),
);
delete globalThis.leakedVarGlobal;
const blockedAfterVar = caught(() =>
	(0, eval)("var leakedVarGlobal; function blockedFunctionGlobal(){}"),
);
ok(
	"invalid function prevents earlier var creation",
	blockedAfterVar instanceof SyntaxError,
);
ok("failed declaration does not leak var", !("leakedVarGlobal" in globalThis));
const mixedBlocked = caught(() =>
	(0, eval)("var blockedFunctionGlobal; function blockedFunctionGlobal(){}"),
);
ok("same-name var does not suppress function check", mixedBlocked instanceof SyntaxError);

Object.defineProperty(globalThis, "cacheMutationGlobal", {
	value: 11,
	writable: true,
	configurable: true,
});
function readMutationGlobal() {
	return cacheMutationGlobal;
}
ok("configurable cache property reads", readMutationGlobal() === 11);
delete globalThis.cacheMutationGlobal;
globalThis.cacheMutationGlobal = 12;
ok("delete and recreate invalidates cache", readMutationGlobal() === 12);

Object.defineProperty(globalThis, "cacheAccessorGlobal", {
	configurable: true,
	get() {
		return 21;
	},
});
function readAccessorGlobal() {
	return cacheAccessorGlobal;
}
ok("accessor global reads", readAccessorGlobal() === 21);
Object.defineProperty(globalThis, "cacheAccessorGlobal", {
	value: 22,
	writable: true,
	configurable: true,
});
ok("accessor replacement invalidates cache", readAccessorGlobal() === 22);

let inheritedSetterValue = 0;
Object.defineProperty(Object.prototype, "inheritedSetterGlobal", {
	configurable: true,
	set(value) {
		inheritedSetterValue = value;
	},
});
(0, eval)("inheritedSetterGlobal = 33");
ok(
	"inherited setter handles global store",
	inheritedSetterValue === 33 &&
		!Object.prototype.hasOwnProperty.call(globalThis, "inheritedSetterGlobal"),
);
delete Object.prototype.inheritedSetterGlobal;

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
