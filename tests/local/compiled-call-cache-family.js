let checks = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	checks++;
}

function invoke(holder, value, expected) {
	return holder.fn(value, expected);
}

function makeClosure(captured) {
	return function freshClosure(value, expected) {
		return this.bias + captured + value + (freshClosure === expected ? 0 : 1000000);
	};
}

for (let i = 0; i < 128; i++) {
	const fn = makeClosure(i);
	ok("fresh captured closure", invoke({ bias: 1000, fn }, 7, fn) === 1007 + i);
}

const retained = makeClosure(2000);
const retainedHolder = { bias: 30, fn: retained };
ok("exact compiled identity first", invoke(retainedHolder, 12, retained) === 2042);
ok("exact compiled identity hit", invoke(retainedHolder, 13, retained) === 2043);

function invokeBare(fn, value) {
	return fn(value);
}

function makeStrictClosure(captured) {
	return function (value) {
		"use strict";
		return this === undefined ? captured + value : -1;
	};
}

for (let i = 0; i < 32; i++) {
	ok("fresh strict this", invokeBare(makeStrictClosure(i), 10) === i + 10);
}

const gc = globalThis.__mal_collect_garbage;
for (let i = 0; i < 24; i++) {
	const fn = makeClosure(3000 + i);
	ok("fresh closure across GC epochs", invoke({ bias: 4, fn }, 5, fn) === 3009 + i);
	if (typeof gc === "function") gc();
}

eval("(function compiledCallCacheSpliceOne() { return 1; })");
new Function("return 2");
const afterSplice = makeClosure(4000);
ok(
	"definition realloc family hit",
	invoke({ bias: 20, fn: afterSplice }, 22, afterSplice) === 4042,
);

const bound = function (value) {
	return this.base + value;
}.bind({ base: 40 });
ok("bound fallback", invoke({ fn: bound }, 2, bound) === 42);

const proxied = new Proxy(function (value) {
	return value + 1;
}, {});
ok("proxy fallback", invoke({ fn: proxied }, 41, proxied) === 42);

ok("native fill", invoke({ fn: Number }, "42", Number) === 42);
ok("native exact identity", invoke({ fn: Number }, "42", Number) === 42);

const interpreted = eval("(function(value) { return value + 2; })");
ok("interpreted fallback", invoke({ fn: interpreted }, 40, interpreted) === 42);

const afterFallback = makeClosure(5000);
ok(
	"compiled family after fallbacks",
	invoke({ bias: 10, fn: afterFallback }, 5, afterFallback) === 5015,
);

function recursiveInvoke(fn, depth) {
	return fn(depth);
}

function makeRecursive(captured) {
	return function (depth) {
		if (depth === 0) return captured;
		return recursiveInvoke(makeRecursive(captured + 1), depth - 1);
	};
}

ok("cold reentrant fill", recursiveInvoke(makeRecursive(10), 6) === 16);
ok("reentrant family hit", recursiveInvoke(makeRecursive(20), 4) === 24);

function polyInvoke(fn, value) {
	return fn(value);
}

function makeA(captured) {
	return (value) => captured + value;
}
function makeB(captured) {
	return (value) => captured + value;
}
function makeC(captured) {
	return (value) => captured + value;
}
function makeD(captured) {
	return (value) => captured + value;
}
function makeE(captured) {
	return (value) => captured + value;
}

const makers = [makeA, makeB, makeC, makeD, makeE];
for (let round = 0; round < 3; round++) {
	for (let i = 0; i < makers.length; i++) {
		const captured = round * 100 + i;
		ok("polymorphic fresh closure", polyInvoke(makers[i](captured), 7) === captured + 7);
	}
}

ok("checks ran", checks === 210);
console.log("compiled-call-cache-family PASS");
