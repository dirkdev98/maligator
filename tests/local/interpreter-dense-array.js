"use strict";

let checks = 0;

function check(condition, message) {
	if (!condition) throw new Error("FAIL " + message);
	checks++;
}

function load(array, index) {
	return array[index];
}

function store(array, index, value) {
	array[index] = value;
}

function throwsTypeError(callback) {
	try {
		callback();
	} catch (error) {
		return error instanceof TypeError;
	}
	return false;
}

const dense = [0, 1, 2, 3];
let denseSum = 0;
for (let i = 0; i < 3000; i++) {
	const index = i & 3;
	store(dense, index, i);
	denseSum += load(dense, index);
}
check(denseSum === 4498500, "dense overwrite and load hits");

const appended = [];
for (let i = 0; i < 1000; i++) {
	store(appended, i, i + 1);
}
let appendSum = 0;
for (let i = 0; i < 1000; i++) {
	appendSum += load(appended, i);
}
check(appended.length === 1000 && appendSum === 500500, "dense fresh stores grow length");

const collect = globalThis.__mal_collect_garbage;
const barrierArray = [{ marker: -1 }];
if (typeof collect === "function") {
	collect();
	collect();
}
for (let i = 0; i < 200; i++) {
	const child = { marker: i };
	store(barrierArray, 0, child);
	for (let j = 0; j < 20; j++) ({ garbage: j, iteration: i });
	if (typeof collect === "function" && i % 10 === 0) collect();
	check(load(barrierArray, 0) === child, "barriered dense store " + i);
}

const hole = [10, 20, 30];
delete hole[1];
check(load(hole, 1) === undefined && !Object.hasOwn(hole, 1), "hole load falls back");

const fixedLength = [1];
Object.defineProperty(fixedLength, "length", { writable: false });
store(fixedLength, 0, 2);
check(load(fixedLength, 0) === 2, "existing element ignores fixed length");
check(
	throwsTypeError(() => store(fixedLength, 1, 3)) && fixedLength.length === 1,
	"fixed length rejects append",
);

const nonExtensible = [1];
Object.preventExtensions(nonExtensible);
store(nonExtensible, 0, 2);
check(load(nonExtensible, 0) === 2, "existing element ignores extensibility");
check(
	throwsTypeError(() => store(nonExtensible, 1, 3)) && !Object.hasOwn(nonExtensible, 1),
	"non-extensible array rejects fresh index",
);

const sparse = [11];
store(sparse, 5000, 22);
check(load(sparse, 5000) === 22 && sparse.length === 5001, "sparse store falls back");
store(sparse, 0, 33);
check(load(sparse, 0) === 33, "deoptimized array stays on generic path");

const ranged = [];
store(ranged, -1, "negative");
store(ranged, 2147483648, "large");
store(ranged, 4294967295, "max");
check(load(ranged, -1) === "negative", "negative key falls back");
check(load(ranged, 2147483648) === "large", "non-int32 array index falls back");
check(load(ranged, 4294967295) === "max", "non-array-index key falls back");

let customGetCalls = 0;
let customSetValue;
const customPrototype = {
	get 1() {
		customGetCalls++;
		return 71;
	},
	set 2(value) {
		customSetValue = value;
	},
};
const custom = [10];
Object.setPrototypeOf(custom, customPrototype);
check(load(custom, 1) === 71 && customGetCalls === 1, "custom prototype hole getter");
store(custom, 2, 72);
check(customSetValue === 72 && !Object.hasOwn(custom, 2), "custom prototype hole setter");
store(custom, 0, 73);
check(load(custom, 0) === 73, "own element shadows custom prototype");

let inheritedGetCalls = 0;
Object.defineProperty(Array.prototype, "1", {
	configurable: true,
	get() {
		inheritedGetCalls++;
		return 81;
	},
});
const inheritedHole = [80, , 82];
check(load(inheritedHole, 1) === 81 && inheritedGetCalls === 1, "protected hole getter");
delete Array.prototype[1];

let inheritedSetValue;
Object.defineProperty(Array.prototype, "3", {
	configurable: true,
	set(value) {
		inheritedSetValue = value;
	},
});
const inheritedStore = [80];
store(inheritedStore, 3, 83);
check(
	inheritedSetValue === 83 &&
		!Object.hasOwn(inheritedStore, 3) &&
		inheritedStore.length === 1,
	"protector invalidation routes fresh store to setter",
);
delete Array.prototype[3];

const setterError = new Error("inherited setter throw");
Object.defineProperty(Array.prototype, "4", {
	configurable: true,
	set() {
		throw setterError;
	},
});
let caughtError;
try {
	store([], 4, 84);
} catch (error) {
	caughtError = error;
}
delete Array.prototype[4];
check(caughtError === setterError, "fallback throw resumes at catch");

console.log("interpreter-dense-array PASS " + checks);
