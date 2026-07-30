"use strict";

let checks = 0;

function check(condition, message) {
	if (!condition) throw new Error("FAIL " + message);
	checks++;
}

function loadStatic(object) {
	return object.value;
}

function loadDynamic(object, key) {
	return object[key];
}

function storeStatic(object, value) {
	object.value = value;
}

function storeDynamic(object, key, value) {
	object[key] = value;
}

const own = { value: 0, other: 1 };
for (let i = 0; i < 2000; i++) {
	check(loadStatic(own) === i, "static own load");
	check(loadDynamic(own, "other") === i + 1, "dynamic own load");
	storeStatic(own, i + 1);
	storeDynamic(own, "other", i + 2);
}

own.extra = 1;
check(loadStatic(own) === 2000, "shape mutation invalidates own load");
storeStatic(own, 2001);
check(loadStatic(own) === 2001, "shape mutation refills own load");

function loadMissing(object) {
	return object.__mal_definitely_missing_ic__;
}
const missingReceiver = { present: 2 };
for (let i = 0; i < 1000; i++) {
	check(loadMissing(missingReceiver) === undefined, "missing load");
}
const missingPrototype = { __mal_definitely_missing_ic__: 3 };
Object.setPrototypeOf(missingReceiver, missingPrototype);
check(loadMissing(missingReceiver) === 3, "prototype addition invalidates missing load");
delete missingPrototype.__mal_definitely_missing_ic__;
check(
	loadMissing(missingReceiver) === undefined,
	"prototype delete refills missing load",
);
missingReceiver.__mal_definitely_missing_ic__ = 4;
check(loadMissing(missingReceiver) === 4, "own addition invalidates missing load");
delete missingReceiver.__mal_definitely_missing_ic__;
Object.defineProperty(missingPrototype, "__mal_definitely_missing_ic__", {
	configurable: true,
	get() {
		return 5;
	},
});
check(loadMissing(missingReceiver) === 5, "prototype accessor invalidates missing load");
delete missingPrototype.__mal_definitely_missing_ic__;

const inheritedMethod = Array.prototype.slice;
function loadInherited(array) {
	return array.slice;
}
const inheritedReceiver = [];
for (let i = 0; i < 1000; i++) {
	check(loadInherited(inheritedReceiver) === inheritedMethod, "inherited data load");
}

function stringLength(value) {
	return value.length;
}
function arrayLength(value) {
	return value.length;
}
const lengthArray = [1, 2, 3];
for (let i = 0; i < 1000; i++) {
	check(
		stringLength(i % 2 === 0 ? "cache" : "ic") === (i % 2 === 0 ? 5 : 2),
		"string length",
	);
	check(arrayLength(lengthArray) === 3, "array length");
}

let getterCalls = 0;
const accessor = {};
Object.defineProperty(accessor, "value", {
	get() {
		getterCalls++;
		return getterCalls;
	},
});
check(loadStatic(accessor) === 1, "accessor first load");
check(loadStatic(accessor) === 2, "accessor repeats");
const accessorError = new Error("accessor throw");
const throwingAccessor = {};
Object.defineProperty(throwingAccessor, "value", {
	get() {
		throw accessorError;
	},
});
function catchPropertyInFrame(object) {
	try {
		return object.value;
	} catch (error) {
		return error;
	}
}
check(
	catchPropertyInFrame(throwingAccessor) === accessorError,
	"accessor throw caught in helper frame",
);
let caughtError;
try {
	loadStatic(throwingAccessor);
} catch (error) {
	caughtError = error;
}
check(caughtError === accessorError, "accessor throw resumes at catch");

let proxyGets = 0;
let proxySets = 0;
let proxyError;
const proxyTarget = { value: 10 };
const proxy = new Proxy(proxyTarget, {
	get(target, key, receiver) {
		if (proxyError !== undefined) throw proxyError;
		proxyGets++;
		return Reflect.get(target, key, receiver);
	},
	set(target, key, value, receiver) {
		if (proxyError !== undefined) throw proxyError;
		proxySets++;
		return Reflect.set(target, key, value, receiver);
	},
});
check(loadStatic(proxy) === 10, "proxy load first");
check(loadStatic(proxy) === 10 && proxyGets === 2, "proxy load repeats trap");
storeStatic(proxy, 11);
storeStatic(proxy, 12);
check(proxyTarget.value === 12 && proxySets === 2, "proxy store repeats trap");
proxyError = new Error("proxy throw");
caughtError = undefined;
try {
	loadStatic(proxy);
} catch (error) {
	caughtError = error;
}
check(caughtError === proxyError, "proxy load throw resumes at catch");
check(catchPropertyInFrame(proxy) === proxyError, "proxy throw caught in helper frame");
caughtError = undefined;
try {
	storeStatic(proxy, 13);
} catch (error) {
	caughtError = error;
}
check(caughtError === proxyError, "proxy store throw resumes at catch");
proxyError = undefined;

function loadWatched() {
	return Math.floor;
}
const originalFloor = Math.floor;
for (let i = 0; i < 1000; i++) {
	check(loadWatched() === originalFloor, "watched own value");
}
Math.floor = function () {
	return 71;
};
check(loadWatched()(1.5) === 71, "watched value invalidation");

const collect = globalThis.__mal_collect_garbage;
const holder = { value: null };
if (typeof collect === "function") {
	collect();
	collect();
}
for (let i = 0; i < 200; i++) {
	const child = { marker: i };
	storeStatic(holder, child);
	for (let j = 0; j < 20; j++) ({ garbage: j, iteration: i });
	if (typeof collect === "function" && i % 10 === 0) collect();
	check(loadStatic(holder).marker === i, "barriered store remains live");
}

console.log("interpreter-property-ic PASS " + checks);
