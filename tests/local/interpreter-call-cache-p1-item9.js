let passed = 0;

function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function invoke(holder, value) {
	return holder.fn(value);
}

function makeAdder(offset) {
	return function (value) {
		return this.bias + offset + value;
	};
}

const holder = { bias: 3, fn: makeAdder(10) };
for (let i = 0; i < 1000; i++) {
	ok("cached closure call", invoke(holder, i) === i + 13);
}

holder.fn = makeAdder(20);
ok("exact callee identity and environment", invoke(holder, 1) === 24);
ok("replacement callee remains cached", invoke(holder, 2) === 25);

const selfAware = function cachedSelf(value) {
	return cachedSelf === selfAware ? this.bias + value : -1;
};
holder.fn = selfAware;
ok("callee and receiver first call", invoke(holder, 4) === 7);
ok("callee and receiver cached call", invoke(holder, 5) === 8);

function invokeBare(fn) {
	return fn();
}
function strictThis() {
	"use strict";
	return this === undefined;
}
ok("strict this first call", invokeBare(strictThis));
ok("strict this cached call", invokeBare(strictThis));

const realm = new ShadowRealm();
const realmInvoke = realm.evaluate(
	"globalThis.interpreterCallCacheP1RealmBias = 30;" +
		"const holder = { bias: 3, fn: function(value) {" +
		"return globalThis.interpreterCallCacheP1RealmBias + this.bias + value;" +
		"} };" +
		"(value) => holder.fn(value)",
);
ok("realm call first", realmInvoke(9) === 42);
ok("realm call cached", realmInvoke(9) === 42);

const bound = function (value) {
	return this.base + value;
}.bind({ base: 30 });
holder.fn = bound;
ok("bound fallback", invoke(holder, 12) === 42);

holder.fn = new Proxy(function (value) {
	return value + 1;
}, {});
ok("proxy fallback", invoke(holder, 41) === 42);

holder.fn = Number;
ok("native fallback", invoke(holder, "42") === 42);

function Pair(left, right) {
	this.total = left + right;
}
ok("construct fallback", new Pair(19, 23).total === 42);
function invokeSpread(fn, args) {
	return fn(...args);
}
ok("spread fallback", invokeSpread((left, right) => left + right, [19, 23]) === 42);

const evalFn = eval(
	"(function interpreterCallCacheP1Eval(value) { return this.bias + value + 30; })",
);
const evalInvoke = eval(
	"(function interpreterCallCacheP1Invoke(holder, value) { return holder.fn(value); })",
);
holder.fn = evalFn;
ok("eval-spliced function first call", evalInvoke(holder, 9) === 42);
ok("eval-spliced function cached call", evalInvoke(holder, 9) === 42);

eval("(function interpreterCallCacheP1SpliceNoise() { return 0; })");
ok("cached index survives later eval splice", evalInvoke(holder, 9) === 42);

const gc = globalThis.__mal_collect_garbage;
if (typeof gc === "function") gc();
ok("heap epoch invalidation", evalInvoke(holder, 9) === 42);
ok("post-GC refill", evalInvoke(holder, 9) === 42);

function compiledFallback(value) {
	return value + 5;
}
holder.fn = compiledFallback;
ok("compiled fallback", evalInvoke(holder, 37) === 42);

ok("checks ran", passed > 1000);
console.log("interpreter-call-cache-p1-item9 PASS");
