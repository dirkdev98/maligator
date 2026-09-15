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
check(load(sparse, 0) === 33, "deoptimized array observes overwrites");

const frozenDense = Object.freeze([undefined, { value: 42 }, 19]);
check(
	load(frozenDense, 0) === undefined && Object.hasOwn(frozenDense, 0),
	"frozen undefined is present",
);
check(
	load(frozenDense, 1).value === 42 && load(frozenDense, 2) === 19,
	"frozen data elements remain readable",
);
check(
	throwsTypeError(() => store(frozenDense, 2, 20)) && load(frozenDense, 2) === 19,
	"frozen element remains non-writable",
);
const sealedDense = Object.seal([21, 22]);
check(load(sealedDense, 0) === 21, "sealed element read");
store(sealedDense, 0, 23);
check(load(sealedDense, 0) === 23, "sealed element overwrite is observed");
check(
	Reflect.defineProperty(sealedDense, "1", { value: 24 }) &&
		Object.getOwnPropertyDescriptor(sealedDense, "1").configurable === false &&
		sealedDense[1] === 24,
	"sealed element accepts a compatible partial define",
);
check(
	Reflect.defineProperty(frozenDense, "2", { value: 19 }) &&
		!Reflect.defineProperty(frozenDense, "2", { value: 20 }),
	"frozen element accepts only a SameValue redefine",
);

const sealedDenseMethods = Object.seal([3, 1, 4]);
sealedDenseMethods.reverse();
sealedDenseMethods.fill(2, 1, 2);
sealedDenseMethods.copyWithin(1, 0, 1);
sealedDenseMethods.sort();
check(
	sealedDenseMethods.join(",") === "3,4,4",
	"sealed packed elements remain writable through mutating builtins",
);
check(
	throwsTypeError(() => sealedDenseMethods.pop()) &&
		sealedDenseMethods.join(",") === "3,4,4",
	"sealed packed elements remain non-configurable",
);

const sealedDenseShift = Object.seal([5, 6, 7]);
check(
	throwsTypeError(() => sealedDenseShift.shift()) &&
		sealedDenseShift.join(",") === "6,7,7" &&
		sealedDenseShift.length === 3,
	"sealed shift preserves writes before its rejected deletion",
);

for (const mutate of [
	(array) => array.reverse(),
	(array) => array.fill(0),
	(array) => array.copyWithin(0, 1),
	(array) => array.sort(),
]) {
	const array = Object.freeze([8, 9]);
	check(
		throwsTypeError(() => mutate(array)) && array.join(",") === "8,9",
		"frozen packed mutation rejects before changing elements",
	);
}

const sealedDenseLength = Object.seal([10, 11, 12]);
sealedDenseLength.length = 5;
check(
	throwsTypeError(() => {
		sealedDenseLength.length = 1;
	}) &&
		sealedDenseLength.length === 3 &&
		sealedDenseLength.join(",") === "10,11,12",
	"sealed packed shrink stops after its highest fixed element",
);

const shiftedFrozen = [31, , 33];
shiftedFrozen[Symbol("before indices")] = 91;
Object.freeze(shiftedFrozen);
check(
	load(shiftedFrozen, 0) === 31 &&
		load(shiftedFrozen, 1) === undefined &&
		load(shiftedFrozen, 2) === 33,
	"entry positions cannot substitute for index keys",
);

for (const freeze of [false, true]) {
	const integrity = freeze ? Object.freeze : Object.seal;
	const array = [{ marker: 91 }, , undefined];
	array.length = 6;
	const symbol = Symbol("integrity data");
	array[symbol] = 92;
	let getterCalls = 0;
	let setterValue;
	const getter = () => {
		getterCalls++;
		return setterValue;
	};
	const setter = (value) => {
		setterValue = value;
	};
	Object.defineProperty(array, "accessor", {
		configurable: true,
		get: getter,
		set: setter,
	});
	Object.defineProperty(array, "hidden", { configurable: true, value: 93 });
	check(integrity(array) === array && getterCalls === 0, "integrity skips getters");
	check(
		Object.isSealed(array) && Object.isFrozen(array) === freeze,
		"array integrity level",
	);
	check(
		array.length === 6 && !Object.hasOwn(array, 1) && Object.hasOwn(array, 2),
		"integrity preserves holes, undefined elements, and trailing length",
	);
	const element = Object.getOwnPropertyDescriptor(array, "0");
	const symbolic = Object.getOwnPropertyDescriptor(array, symbol);
	const hidden = Object.getOwnPropertyDescriptor(array, "hidden");
	const accessor = Object.getOwnPropertyDescriptor(array, "accessor");
	const length = Object.getOwnPropertyDescriptor(array, "length");
	check(
		!element.configurable &&
			element.writable === !freeze &&
			element.enumerable &&
			!symbolic.configurable &&
			symbolic.writable === !freeze &&
			symbolic.value === 92 &&
			!hidden.configurable &&
			!hidden.writable &&
			!hidden.enumerable &&
			hidden.value === 93,
		"integrity preserves data values and narrows descriptor flags",
	);
	check(
		!accessor.configurable &&
			!accessor.enumerable &&
			accessor.get === getter &&
			accessor.set === setter &&
			!Object.hasOwn(accessor, "writable"),
		"integrity retains accessor identity and descriptor kind",
	);
	check(
		!length.configurable && !length.enumerable && length.writable === !freeze,
		"array length integrity lives outside indexed properties",
	);
	array.accessor = 94;
	check(array.accessor === 94 && getterCalls === 1, "frozen accessors retain setters");
	check(
		throwsTypeError(() => store(array, 1, 95)),
		"integrity forbids filling holes",
	);
	check(
		throwsTypeError(() => {
			delete array[0];
		}),
		"integrity forbids element deletion",
	);
	check(
		throwsTypeError(() => {
			array.length = 1;
		}),
		"integrity rejects deleting fixed elements",
	);
	check(array.length === (freeze ? 6 : 3), "sealed shrink stops at last fixed element");
	Object.freeze(array);
	Object.seal(array);
	check(Object.isFrozen(array), "seal cannot undo a previous freeze");
}

const frozenEmpty = Object.freeze([]);
const sealedEmpty = Object.seal([]);
check(
	throwsTypeError(() => frozenEmpty.pop()),
	"empty frozen pop still writes length",
);
check(
	sealedEmpty.pop() === undefined &&
		Object.getOwnPropertyDescriptor(sealedEmpty, "length").writable,
	"sealed empty length stays writable",
);
sealedEmpty.length = 2;
check(
	sealedEmpty.length === 2 && !Object.hasOwn(sealedEmpty, 0),
	"sealed empty length can grow without creating elements",
);

class IntegrityArray extends Array {
	#marker = 96;
	read() {
		return this.#marker;
	}
	write(value) {
		this.#marker = value;
	}
}
const privateArray = new IntegrityArray();
privateArray.push({ marker: 97 });
Object.freeze(privateArray);
privateArray.write(98);
if (typeof collect === "function") collect();
check(
	privateArray.read() === 98 && privateArray[0].marker === 97,
	"freezing an array keeps private fields mutable",
);

const frozenObjects = [];
for (let index = 0; index < 40; index++) frozenObjects.push({ marker: index + 100 });
if (typeof collect === "function") collect();
Object.freeze(frozenObjects);
if (typeof collect === "function") collect();
for (let index = 0; index < frozenObjects.length; index++) {
	check(
		load(frozenObjects, index).marker === index + 100,
		"frozen migration roots element values",
	);
}

let indexedGetterCalls = 0;
const changingDictionary = [41, 42, 43];
Object.defineProperty(changingDictionary, "1", {
	configurable: true,
	get() {
		indexedGetterCalls++;
		return this[0] + 10;
	},
});
check(
	load(changingDictionary, 1) === 51 && indexedGetterCalls === 1,
	"dictionary accessor runs with the original receiver",
);
Object.defineProperty(changingDictionary, "1", {
	configurable: true,
	writable: true,
	value: 52,
});
check(
	load(changingDictionary, 1) === 52,
	"accessor replacement exposes the new data value",
);
delete changingDictionary[0];
check(load(changingDictionary, 0) === undefined, "deleted entry is absent");
store(changingDictionary, 0, 53);
check(
	load(changingDictionary, 0) === 53,
	"reinserted index may occupy a different entry",
);
for (let index = 3; index < 160; index++) store(changingDictionary, index, index + 100);
for (let index = 3; index < 150; index++) delete changingDictionary[index];
for (let index = 160; index < 240; index++) store(changingDictionary, index, index + 100);
check(
	load(changingDictionary, 0) === 53 &&
		load(changingDictionary, 1) === 52 &&
		load(changingDictionary, 2) === 43 &&
		load(changingDictionary, 149) === undefined &&
		load(changingDictionary, 239) === 339,
	"growth and deletion preserve dictionary element reads",
);
Object.defineProperty(changingDictionary, "1", {
	get() {
		throw new TypeError("dictionary accessor");
	},
});
check(
	throwsTypeError(() => load(changingDictionary, 1)),
	"dictionary accessor exceptions propagate",
);

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
const frozenInheritedHole = Object.freeze([70, , 72]);
Object.defineProperty(Array.prototype, "1", {
	configurable: true,
	get() {
		inheritedGetCalls++;
		return 81;
	},
});
const inheritedHole = [80, , 82];
check(load(inheritedHole, 1) === 81 && inheritedGetCalls === 1, "protected hole getter");
check(
	load(frozenInheritedHole, 1) === 81 && inheritedGetCalls === 2,
	"frozen hole observes a newly inherited getter",
);
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

const reversedLength = [2, 3, 4];
let reversedLengthProduct = 1;
for (let index = 0; reversedLength.length > index; ++index) {
	reversedLengthProduct *= reversedLength[index];
}
check(reversedLengthProduct === 24, "indexed loop supports reversed length comparison");

const unequalLength = [5, 6, 7];
let unequalLengthSum = 0;
for (let index = 0; index !== unequalLength.length; ++index) {
	unequalLengthSum += unequalLength[index];
}
check(unequalLengthSum === 18, "indexed loop supports strict length inequality");

let loopHoleSetValue;
const loopStorePrototype = Object.create(Array.prototype, {
	1: {
		configurable: true,
		set(value) {
			loopHoleSetValue = value;
		},
	},
});
const loopStored = [1, , 3];
Object.setPrototypeOf(loopStored, loopStorePrototype);
for (let index = 0; index < loopStored.length; ++index) {
	loopStored[index] = index + 10;
}
check(
	loopStored[0] === 10 &&
		loopHoleSetValue === 11 &&
		!Object.hasOwn(loopStored, 1) &&
		loopStored[2] === 12,
	"indexed loop store preserves inherited hole setter",
);

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
