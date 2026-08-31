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

const indexedGrowing = [1, 2];
const indexedGrownValues = [];
for (let index = 0; index < indexedGrowing.length; ++index) {
	indexedGrownValues.push(indexedGrowing[index]);
	if (index === 0) indexedGrowing.push(3);
}
check(indexedGrownValues.join(",") === "1,2,3", "indexed loop reads live growing length");

const indexedShrinking = [1, 2, 3];
const indexedShrunkValues = [];
for (let index = 0; index < indexedShrinking.length; ++index) {
	indexedShrunkValues.push(indexedShrinking[index]);
	indexedShrinking.length = 1;
}
check(indexedShrunkValues.join(",") === "1", "indexed loop reads live shrinking length");

let proxyLengthGets = 0;
const indexedProxy = new Proxy([4, 5], {
	get(target, key, receiver) {
		if (key === "length") proxyLengthGets++;
		return Reflect.get(target, key, receiver);
	},
});
let indexedProxySum = 0;
for (let index = 0; index < indexedProxy.length; ++index) {
	indexedProxySum += indexedProxy[index];
}
check(indexedProxySum === 9 && proxyLengthGets === 3, "indexed proxy keeps length gets");

let arrayLikeLengthGets = 0;
let arrayLikeLengthCoercions = 0;
const indexedArrayLike = {
	0: 6,
	1: 7,
	get length() {
		arrayLikeLengthGets++;
		return {
			[Symbol.toPrimitive]() {
				arrayLikeLengthCoercions++;
				return 2;
			},
		};
	},
};
let indexedArrayLikeSum = 0;
for (let index = 0; index < indexedArrayLike.length; ++index) {
	indexedArrayLikeSum += indexedArrayLike[index];
}
check(
	indexedArrayLikeSum === 13 &&
		arrayLikeLengthGets === 3 &&
		arrayLikeLengthCoercions === 3,
	"indexed array-like keeps length coercions",
);

let iteratedSum = 0;
const iterated = [1, 2, 3, 4];
for (let repeat = 0; repeat < 500; repeat++) {
	for (const value of iterated) iteratedSum += value;
}
check(iteratedSum === 5000, "dense for-of values");

function* denseIteratorAcrossYield() {
	let sum = 0;
	for (const value of [1, 2]) {
		yield value;
		sum += value;
	}
	return sum;
}
const suspendedDenseIterator = denseIteratorAcrossYield();
check(
	suspendedDenseIterator.next().value === 1 &&
		suspendedDenseIterator.next().value === 2 &&
		suspendedDenseIterator.next().value === 3,
	"compiled generator restores dense for-of after yields",
);

const growing = [1, 2];
const grownValues = [];
for (const value of growing) {
	grownValues.push(value);
	if (value === 1) growing.push(3);
}
check(grownValues.join(",") === "1,2,3", "for-of reads live growing length");

const stringIteratorValues = [];
for (const value of "A\u{1f600}B") stringIteratorValues.push(value);
check(
	stringIteratorValues.join("|") === "A|\u{1f600}|B",
	"string for-of advances by Unicode code point",
);

const typedArrayIteratorValues = [];
for (const value of new Uint16Array([5, 9])) typedArrayIteratorValues.push(value);
check(typedArrayIteratorValues.join(",") === "5,9", "TypedArray for-of reads values");

const liveMap = new Map([
	["a", 1],
	["b", 2],
]);
const liveMapValues = [];
for (const entry of liveMap) {
	liveMapValues.push(entry[0] + ":" + entry[1]);
	if (entry[0] === "a") {
		liveMap.delete("b");
		liveMap.set("c", 3);
	}
}
check(liveMapValues.join(",") === "a:1,c:3", "Map for-of observes live mutations");

const liveSet = new Set([1, 2]);
const liveSetValues = [];
for (const value of liveSet) {
	liveSetValues.push(value);
	if (value === 1) {
		liveSet.delete(2);
		liveSet.add(3);
	}
}
check(liveSetValues.join(",") === "1,3", "Set for-of observes live mutations");

const shrinking = [1, 2, 3];
const shrunkValues = [];
for (const value of shrinking) {
	shrunkValues.push(value);
	shrinking.length = 1;
}
check(shrunkValues.join(",") === "1", "for-of reads live shrinking length");

let iteratorHoleGets = 0;
const iteratorPrototype = Object.create(Array.prototype, {
	1: {
		configurable: true,
		get() {
			iteratorHoleGets++;
			return 91;
		},
	},
});
const iteratorHole = [90, , 92];
Object.setPrototypeOf(iteratorHole, iteratorPrototype);
const iteratorHoleValues = [];
for (const value of iteratorHole) iteratorHoleValues.push(value);
check(
	iteratorHoleValues.join(",") === "90,91,92" && iteratorHoleGets === 1,
	"for-of hole uses prototype Get",
);

const builtinArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const originalArrayIteratorNext = builtinArrayIteratorPrototype.next;
let patchedNextCalls = 0;
builtinArrayIteratorPrototype.next = function () {
	patchedNextCalls++;
	return originalArrayIteratorNext.call(this);
};
let patchedIteratorSum = 0;
for (const value of [4, 5]) patchedIteratorSum += value;
builtinArrayIteratorPrototype.next = originalArrayIteratorNext;
check(
	patchedIteratorSum === 9 && patchedNextCalls === 3,
	"for-of honors captured patched iterator next",
);

let customNextCalls = 0;
let customCloseCalls = 0;
const customIterable = [1, 2, 3];
customIterable[Symbol.iterator] = function () {
	let index = 0;
	return {
		next() {
			customNextCalls++;
			return index < 3 ? { value: ++index, done: false } : { done: true };
		},
		return() {
			customCloseCalls++;
			return { done: true };
		},
	};
};
for (const value of customIterable) {
	if (value === 2) break;
}
check(
	customNextCalls === 2 && customCloseCalls === 1,
	"for-of custom iterator and close fallback",
);

let proxyGets = 0;
const proxiedArray = new Proxy([6, 7], {
	get(target, key, receiver) {
		proxyGets++;
		return Reflect.get(target, key, receiver);
	},
});
let proxySum = 0;
for (const value of proxiedArray) proxySum += value;
check(proxySum === 13 && proxyGets >= 6, "for-of proxy fallback");

class DenseArraySubclass extends Array {}
let subclassSum = 0;
for (const value of new DenseArraySubclass(8, 9)) subclassSum += value;
check(subclassSum === 17, "for-of dense Array subclass");

console.log("interpreter-dense-array PASS " + checks);
