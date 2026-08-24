"use strict";

let passed = 0;
let total = 0;
function check(name, condition) {
	total++;
	if (condition) {
		passed++;
	} else {
		console.log("FAIL: " + name);
	}
}

const hostGc = globalThis.__mal_collect_garbage;
function collect() {
	const garbage = [];
	for (let i = 0; i < 64; i++) garbage.push({ value: "garbage-" + i });
	if (typeof hostGc === "function") hostGc();
}

function makeNewTarget(marker, onGet) {
	return new Proxy(function () {}, {
		get(target, key, receiver) {
			if (key === "prototype") {
				onGet();
				const prototype = { marker };
				collect();
				return prototype;
			}
			return Reflect.get(target, key, receiver);
		},
	});
}

const ignoredObject = { ignored: true };
let objectPrototypeGets = 0;
const derivedObject = Reflect.construct(
	Object,
	[ignoredObject],
	makeNewTarget(101, () => objectPrototypeGets++),
);
check(
	"Object derived construction",
	derivedObject !== ignoredObject &&
		!Object.hasOwn(derivedObject, "ignored") &&
		Object.getPrototypeOf(derivedObject).marker === 101 &&
		objectPrototypeGets === 1,
);

let mapPrototypeGets = 0;
const derivedMap = Reflect.construct(
	Map,
	[],
	makeNewTarget(202, () => mapPrototypeGets++),
);
Map.prototype.set.call(derivedMap, "answer", 42);
check(
	"Map custom newTarget prototype once",
	Map.prototype.get.call(derivedMap, "answer") === 42 &&
		Object.getPrototypeOf(derivedMap).marker === 202 &&
		mapPrototypeGets === 1,
);

let setPrototypeGets = 0;
const derivedSet = Reflect.construct(
	Set,
	[],
	makeNewTarget(303, () => setPrototypeGets++),
);
Set.prototype.add.call(derivedSet, "value");
check(
	"Set custom newTarget prototype once",
	Set.prototype.has.call(derivedSet, "value") &&
		Object.getPrototypeOf(derivedSet).marker === 303 &&
		setPrototypeGets === 1,
);

const capturedSetAdderPrototype = Object.create(Set.prototype);
function CapturedSetAdderTarget() {}
CapturedSetAdderTarget.prototype = capturedSetAdderPrototype;
let replacementSetAdderCalls = 0;
const capturedSetAdderIterable = {
	get [Symbol.iterator]() {
		Object.defineProperty(capturedSetAdderPrototype, "add", {
			value() {
				replacementSetAdderCalls++;
			},
		});
		let emitted = false;
		return function () {
			return {
				next() {
					if (emitted) return { done: true };
					emitted = true;
					return { done: false, value: "captured-set-value" };
				},
			};
		};
	},
};
const capturedSetAdder = Reflect.construct(
	Set,
	[capturedSetAdderIterable],
	CapturedSetAdderTarget,
);
check(
	"Set constructor retains the adder captured before iterator effects",
	replacementSetAdderCalls === 0 &&
		Set.prototype.has.call(capturedSetAdder, "captured-set-value"),
);

let intrinsicMapPrototypeGets = 0;
const intrinsicMapTarget = new Proxy(function () {}, {
	get(target, key, receiver) {
		if (key === "prototype") {
			intrinsicMapPrototypeGets++;
			return Map.prototype;
		}
		return Reflect.get(target, key, receiver);
	},
});
Reflect.construct(Map, [], intrinsicMapTarget);
check("Map intrinsic newTarget prototype once", intrinsicMapPrototypeGets === 1);

let intrinsicSetPrototypeGets = 0;
const intrinsicSetTarget = new Proxy(function () {}, {
	get(target, key, receiver) {
		if (key === "prototype") {
			intrinsicSetPrototypeGets++;
			return Set.prototype;
		}
		return Reflect.get(target, key, receiver);
	},
});
Reflect.construct(Set, [], intrinsicSetTarget);
check("Set intrinsic newTarget prototype once", intrinsicSetPrototypeGets === 1);

const proxyAdderValue = { marker: 404 };
const proxyAdderPrototype = Object.create(Set.prototype);
Object.defineProperty(proxyAdderPrototype, "add", {
	value: new Proxy(function () {}, {
		apply(target, receiver, args) {
			collect();
			return Set.prototype.add.call(receiver, args[0]);
		},
	}),
});
function ProxyAdderSet() {}
ProxyAdderSet.prototype = proxyAdderPrototype;
const proxyAdderSet = Reflect.construct(Set, [[proxyAdderValue]], ProxyAdderSet);
check(
	"Set constructor roots item before callable Proxy dispatch",
	Set.prototype.has.call(proxyAdderSet, proxyAdderValue),
);

check(
	"Object primitive prototypes and tags",
	Object.getPrototypeOf(Symbol("s")) === Symbol.prototype &&
		Object.getPrototypeOf(1n) === BigInt.prototype &&
		Object.prototype.toString.call(Symbol("s")) === "[object Symbol]" &&
		Object.prototype.toString.call(Object(Symbol("s"))) === "[object Symbol]" &&
		Object.prototype.toString.call(1n) === "[object BigInt]" &&
		Object.prototype.toString.call(Object(1n)) === "[object BigInt]",
);

function LazyConstructor() {}
const lazyDescriptors = Object.getOwnPropertyDescriptors(LazyConstructor);
check(
	"Object descriptors include lazy function prototype",
	Object.hasOwn(lazyDescriptors, "prototype") &&
		lazyDescriptors.prototype.writable === true &&
		lazyDescriptors.prototype.enumerable === false &&
		lazyDescriptors.prototype.configurable === false,
);

const descriptorSymbol = Symbol("descriptor");
const descriptorLog = [];
const descriptorTarget = { alpha: 1, [descriptorSymbol]: 2 };
const descriptorProxy = new Proxy(descriptorTarget, {
	ownKeys(target) {
		descriptorLog.push("keys");
		collect();
		return Reflect.ownKeys(target);
	},
	getOwnPropertyDescriptor(target, key) {
		descriptorLog.push(typeof key === "symbol" ? "symbol" : key);
		collect();
		return Reflect.getOwnPropertyDescriptor(target, key);
	},
});
const reflectedDescriptors = Object.getOwnPropertyDescriptors(descriptorProxy);
check(
	"Object descriptor proxy order and roots",
	descriptorLog.join(",") === "keys,alpha,symbol" &&
		reflectedDescriptors.alpha.value === 1 &&
		reflectedDescriptors[descriptorSymbol].value === 2,
);
check(
	"Object symbol keys share exotic ownKeys path",
	Object.getOwnPropertySymbols(descriptorProxy)[0] === descriptorSymbol,
);

const plainSymbolFirst = Symbol("plain-first");
const plainSymbolSecond = Symbol("plain-second");
let plainSymbolGetterCalls = 0;
const plainSymbolSource = { stringKey: 1, 4: 2 };
plainSymbolSource[plainSymbolFirst] = 3;
Object.defineProperty(plainSymbolSource, plainSymbolSecond, {
	enumerable: false,
	get() {
		plainSymbolGetterCalls++;
		return 4;
	},
});
const plainSymbols = Object.getOwnPropertySymbols(plainSymbolSource);
check(
	"Object plain symbol collection preserves order without reading values",
	plainSymbols.length === 2 &&
		plainSymbols[0] === plainSymbolFirst &&
		plainSymbols[1] === plainSymbolSecond &&
		plainSymbolGetterCalls === 0,
);

let plainKeyGetterCalls = 0;
const plainKeySymbol = Symbol("plain-key");
const plainKeySource = { beta: 1, 7: 2, alpha: 3, 2: 4 };
Object.defineProperty(plainKeySource, "observed", {
	enumerable: true,
	get() {
		plainKeyGetterCalls++;
		return 5;
	},
});
Object.defineProperty(plainKeySource, "hidden", {
	value: 6,
	enumerable: false,
});
plainKeySource[plainKeySymbol] = 7;
check(
	"Object plain key collection preserves order and descriptors",
	Object.keys(plainKeySource).join(",") === "2,7,beta,alpha,observed" &&
		Object.getOwnPropertyNames(plainKeySource).join(",") ===
			"2,7,beta,alpha,observed,hidden" &&
		plainKeyGetterCalls === 0,
);

const plainDataSymbol = Symbol("plain-data");
const plainDataSource = { beta: 2, 7: 7, alpha: 1, 2: 2 };
Object.defineProperty(plainDataSource, "hidden", {
	value: 9,
	enumerable: false,
});
plainDataSource[plainDataSymbol] = 11;
check(
	"Object plain data collection preserves order and filtering",
	Object.values(plainDataSource).join(",") === "2,7,2,1" &&
		Object.entries(plainDataSource)
			.map((entry) => entry.join(":"))
			.join(",") === "2:2,7:7,beta:2,alpha:1",
);

const frozenPlain = Object.freeze({ alpha: 1, beta: 2 });
const sealedPlain = Object.seal({ alpha: 1 });
check(
	"Object plain integrity predicates inspect descriptors directly",
	Object.isFrozen(frozenPlain) &&
		Object.isSealed(frozenPlain) &&
		Object.isSealed(sealedPlain) &&
		!Object.isFrozen(sealedPlain),
);

const integritySymbol = Symbol("integrity");
let integrityAccessorValue = 3;
const detailedFrozen = { data: 1, [integritySymbol]: 2 };
Object.defineProperty(detailedFrozen, "accessor", {
	get() {
		return integrityAccessorValue;
	},
	set(value) {
		integrityAccessorValue = value;
	},
	enumerable: true,
	configurable: true,
});
Object.freeze(detailedFrozen);
const frozenDataDescriptor = Object.getOwnPropertyDescriptor(detailedFrozen, "data");
const frozenAccessorDescriptor = Object.getOwnPropertyDescriptor(
	detailedFrozen,
	"accessor",
);
const frozenSymbolDescriptor = Object.getOwnPropertyDescriptor(
	detailedFrozen,
	integritySymbol,
);
detailedFrozen.accessor = 9;
const detailedSealed = Object.seal({ writable: 4 });
detailedSealed.writable = 5;
const sealedDescriptor = Object.getOwnPropertyDescriptor(detailedSealed, "writable");
check(
	"Object plain integrity updates data accessor and symbol descriptors",
	!frozenDataDescriptor.writable &&
		!frozenDataDescriptor.configurable &&
		frozenAccessorDescriptor.get instanceof Function &&
		frozenAccessorDescriptor.set instanceof Function &&
		!frozenAccessorDescriptor.configurable &&
		!frozenSymbolDescriptor.writable &&
		!frozenSymbolDescriptor.configurable &&
		integrityAccessorValue === 9 &&
		sealedDescriptor.writable &&
		!sealedDescriptor.configurable &&
		detailedSealed.writable === 5,
);

let predicateDescriptorCalls = 0;
const predicateProxy = new Proxy(
	{ visible: 1 },
	{
		getOwnPropertyDescriptor(target, key) {
			predicateDescriptorCalls++;
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	},
);
check(
	"Object own predicates inspect internal descriptors",
	Object.hasOwn(predicateProxy, "visible") &&
		Object.prototype.hasOwnProperty.call(predicateProxy, "visible") &&
		Object.prototype.propertyIsEnumerable.call(predicateProxy, "visible") &&
		predicateDescriptorCalls === 3,
);

const localeReceiver = { marker: 505 };
const localeGetLog = [];
const localeProxy = new Proxy(localeReceiver, {
	get(target, key, receiver) {
		localeGetLog.push(key);
		if (key === "toString") {
			collect();
			return function () {
				return this === localeProxy ? "proxy-locale" : "wrong receiver";
			};
		}
		return Reflect.get(target, key, receiver);
	},
});
check(
	"Object.prototype.toLocaleString uses observable Get",
	Object.prototype.toLocaleString.call(localeProxy) === "proxy-locale" &&
		localeGetLog.join(",") === "toString",
);

const protoPayload = { payload: true };
const fromEntriesProto = Object.fromEntries([["__proto__", protoPayload]]);
check(
	"Object.fromEntries creates own __proto__ data",
	Object.getPrototypeOf(fromEntriesProto) === Object.prototype &&
		Object.hasOwn(fromEntriesProto, "__proto__") &&
		fromEntriesProto.__proto__ === protoPayload,
);

const rootedEntriesSource = {};
Object.defineProperty(rootedEntriesSource, "0", {
	enumerable: true,
	get() {
		const value = { marker: 404 };
		collect();
		return value;
	},
});
rootedEntriesSource.after = 2;
const rootedEntries = Object.entries(rootedEntriesSource);
check(
	"Object.entries roots key value and entry",
	rootedEntries[0][0] === "0" &&
		rootedEntries[0][1].marker === 404 &&
		rootedEntries[1].join(":") === "after:2",
);

const freshAssignSource = {};
Object.defineProperty(freshAssignSource, "fresh", {
	enumerable: true,
	get() {
		return { marker: 505 };
	},
});
const assignHandler = {};
Object.defineProperty(assignHandler, "set", {
	get() {
		collect();
		return Reflect.set;
	},
});
const freshAssignTarget = new Proxy({}, assignHandler);
Object.assign(freshAssignTarget, freshAssignSource);
check(
	"Object.assign roots getter value across target trap lookup",
	freshAssignTarget.fresh.marker === 505,
);

const groupSymbol = Symbol("group");
const objectGroups = Object.groupBy([1, 2, 3, 4], (value) => {
	collect();
	return value % 2 === 0 ? groupSymbol : "__proto__";
});
check(
	"Object.groupBy null prototype and property keys",
	Object.getPrototypeOf(objectGroups) === null &&
		objectGroups.__proto__.join(",") === "1,3" &&
		objectGroups[groupSymbol].join(",") === "2,4",
);

let extraArgumentEffects = 0;
function exactObjectIs(left, right) {
	return Object.is(left, right);
}
check(
	"Object.is SameValue direct semantics",
	exactObjectIs(NaN, NaN) &&
		!exactObjectIs(0, -0) &&
		exactObjectIs(undefined, undefined) &&
		Object.is(1, 1, extraArgumentEffects++),
);
check("Object.is extra arguments evaluated", extraArgumentEffects === 1);

const originalObjectIs = Object.is;
let mutablePrimordials = false;
try {
	Object.is = function () {
		return "overridden";
	};
	mutablePrimordials = Object.is !== originalObjectIs;
} catch {}
check(
	"Object.is mutable fallback",
	mutablePrimordials ? Object.is(1, 2) === "overridden" : exactObjectIs(1, 1),
);
if (mutablePrimordials) Object.is = originalObjectIs;

if (mutablePrimordials) {
	const symbolToStringTag = Object.getOwnPropertyDescriptor(
		Symbol.prototype,
		Symbol.toStringTag,
	);
	const bigintToStringTag = Object.getOwnPropertyDescriptor(
		BigInt.prototype,
		Symbol.toStringTag,
	);
	Object.defineProperty(Symbol.prototype, Symbol.toStringTag, {
		value: 17,
		configurable: true,
	});
	Object.defineProperty(BigInt.prototype, Symbol.toStringTag, {
		value: {},
		configurable: true,
	});
	check(
		"Object ignores non-string Symbol and BigInt tags",
		Object.prototype.toString.call(Symbol("s")) === "[object Object]" &&
			Object.prototype.toString.call(Object(Symbol("s"))) === "[object Object]" &&
			Object.prototype.toString.call(1n) === "[object Object]" &&
			Object.prototype.toString.call(Object(1n)) === "[object Object]",
	);
	Object.defineProperty(Symbol.prototype, Symbol.toStringTag, symbolToStringTag);
	Object.defineProperty(BigInt.prototype, Symbol.toStringTag, bigintToStringTag);
}

const constructedFromFreshEntry = new Map({
	[Symbol.iterator]() {
		let emitted = false;
		return {
			next() {
				if (emitted) return { done: true };
				emitted = true;
				return {
					done: false,
					value: {
						get 0() {
							return { marker: 505 };
						},
						get 1() {
							collect();
							return "entry-value";
						},
					},
				};
			},
		};
	},
});
const freshEntryKey = constructedFromFreshEntry.keys().next().value;
check(
	"Map constructor roots first entry component",
	freshEntryKey.marker === 505 &&
		constructedFromFreshEntry.get(freshEntryKey) === "entry-value",
);

const capturedMapAdderPrototype = Object.create(Map.prototype);
function CapturedMapAdderTarget() {}
CapturedMapAdderTarget.prototype = capturedMapAdderPrototype;
let replacementMapAdderCalls = 0;
const capturedMapAdderEntry = {};
Object.defineProperty(capturedMapAdderEntry, "0", {
	get() {
		Object.defineProperty(capturedMapAdderPrototype, "set", {
			value() {
				replacementMapAdderCalls++;
			},
		});
		return "captured-key";
	},
});
Object.defineProperty(capturedMapAdderEntry, "1", {
	get() {
		return "captured-value";
	},
});
const capturedMapAdder = Reflect.construct(
	Map,
	[[capturedMapAdderEntry]],
	CapturedMapAdderTarget,
);
check(
	"Map constructor retains the adder captured before entry Gets",
	replacementMapAdderCalls === 0 &&
		Map.prototype.get.call(capturedMapAdder, "captured-key") === "captured-value",
);

const mapGroupIndices = [];
const mapGroups = Map.groupBy([1, 2, 3, 4], (value, index) => {
	mapGroupIndices.push(index);
	collect();
	return value < 3 ? -0 : NaN;
});
check(
	"Map.groupBy canonical keys and rooted groups",
	mapGroupIndices.join(",") === "0,1,2,3" &&
		mapGroups.size === 2 &&
		mapGroups.get(0).join(",") === "1,2" &&
		mapGroups.get(NaN).join(",") === "3,4" &&
		1 / mapGroups.keys().next().value === Infinity,
);

const upsert = new Map([["present", 1]]);
let computedCalls = 0;
check(
	"Map getOrInsert present and absent",
	upsert.getOrInsert("present", 9) === 1 &&
		upsert.getOrInsert("missing", 2) === 2 &&
		upsert.get("missing") === 2,
);
const canonicalUpsert = new Map();
const canonicalUpsertValue = { marker: 707 };
check(
	"Map getOrInsert single upsert preserves canonical keys and existing values",
	canonicalUpsert.getOrInsert(-0, canonicalUpsertValue) === canonicalUpsertValue &&
		canonicalUpsert.getOrInsert(0, { marker: 808 }) === canonicalUpsertValue &&
		canonicalUpsert.size === 1 &&
		1 / canonicalUpsert.keys().next().value === Infinity,
);
const computedValue = upsert.getOrInsertComputed(-0, (key) => {
	computedCalls++;
	check("Map computed callback canonical key", 1 / key === Infinity);
	upsert.set(0, "callback-write");
	const value = { marker: 606 };
	collect();
	return value;
});
check(
	"Map computed upsert callback mutation",
	computedCalls === 1 &&
		computedValue.marker === 606 &&
		upsert.get(0) === computedValue &&
		upsert.getOrInsertComputed(0, () => {
			computedCalls++;
		}) === computedValue &&
		computedCalls === 1,
);

const nativeLeft = new Set([1, 2, 3]);
const nativeRight = new Set([3, 4]);
check(
	"Set native composition",
	[...nativeLeft.union(nativeRight)].join(",") === "1,2,3,4" &&
		[...nativeLeft.intersection(nativeRight)].join(",") === "3" &&
		[...nativeLeft.difference(nativeRight)].join(",") === "1,2" &&
		[...nativeLeft.symmetricDifference(nativeRight)].join(",") === "1,2,4",
);
check(
	"Set native predicates",
	new Set([1, 2]).isSubsetOf(nativeLeft) &&
		nativeLeft.isSupersetOf(new Set([1, 2])) &&
		nativeLeft.isDisjointFrom(new Set([8, 9])) &&
		!nativeLeft.isDisjointFrom(nativeRight),
);

const setRecordLog = [];
const orderedSetLike = {
	get size() {
		setRecordLog.push("size");
		return 1;
	},
	get has() {
		setRecordLog.push("has");
		return function (value) {
			return value === 2;
		};
	},
	get keys() {
		setRecordLog.push("keys");
		return function () {
			setRecordLog.push("keys-call");
			return [2].values();
		};
	},
};
check(
	"Set record access order",
	[...new Set([1]).union(orderedSetLike)].join(",") === "1,2" &&
		setRecordLog.join(",") === "size,has,keys,keys-call",
);

const inheritedSetRecordLog = [];
class ObservableSetArgument extends Set {}
Object.defineProperties(ObservableSetArgument.prototype, {
	size: {
		get() {
			inheritedSetRecordLog.push("size");
			return 1;
		},
	},
	has: {
		get() {
			inheritedSetRecordLog.push("has");
			return Set.prototype.has;
		},
	},
	keys: {
		get() {
			inheritedSetRecordLog.push("keys");
			return Set.prototype.values;
		},
	},
});
check(
	"Set subclass record access remains observable",
	[...new Set([1]).union(new ObservableSetArgument([2]))].join(",") === "1,2" &&
		inheritedSetRecordLog.join(",") === "size,has,keys",
);

function receiverMutationDuringNextLookup(method) {
	const receiver = new Set([1, 2, 3]);
	const other = {
		size: 0,
		has() {
			return false;
		},
		keys() {
			return {
				get next() {
					receiver.clear();
					receiver.add(4);
					collect();
					return function () {
						return { done: true };
					};
				},
			};
		},
	};
	return [...receiver[method](other)].join(",");
}
check(
	"Set composition copies after iterator next lookup",
	receiverMutationDuringNextLookup("union") === "4" &&
		receiverMutationDuringNextLookup("symmetricDifference") === "4",
);

const intersectionReceiver = new Set([1, 2]);
const intersectionCalls = [];
let intersectionMutated = false;
const intersectionResult = intersectionReceiver.intersection({
	size: 10,
	has(value) {
		intersectionCalls.push(value);
		if (value === 1 && !intersectionMutated) {
			intersectionMutated = true;
			intersectionReceiver.delete(1);
			intersectionReceiver.add(1);
		}
		collect();
		return true;
	},
	keys() {
		throw new Error("unreachable keys");
	},
});
check(
	"Set intersection dynamic receiver and dedupe",
	intersectionCalls.join(",") === "1,2,1" && [...intersectionResult].join(",") === "1,2",
);

const differenceReceiver = new Set([1, 2]);
const differenceCalls = [];
const differenceResult = differenceReceiver.difference({
	size: 10,
	has(value) {
		differenceCalls.push(value);
		if (value === 1) differenceReceiver.add(3);
		collect();
		return false;
	},
	keys() {
		throw new Error("unreachable keys");
	},
});
check(
	"Set difference uses private fixed worklist",
	differenceCalls.join(",") === "1,2" &&
		[...differenceResult].join(",") === "1,2" &&
		differenceReceiver.has(3),
);

const subsetReceiver = new Set([1]);
const subsetCalls = [];
check(
	"Set subset follows receiver growth",
	subsetReceiver.isSubsetOf({
		size: 10,
		has(value) {
			subsetCalls.push(value);
			if (value === 1) subsetReceiver.add(2);
			return true;
		},
		keys() {},
	}) && subsetCalls.join(",") === "1,2",
);

const disjointReceiver = new Set([1]);
const disjointCalls = [];
check(
	"Set disjoint follows receiver growth",
	disjointReceiver.isDisjointFrom({
		size: 10,
		has(value) {
			disjointCalls.push(value);
			if (value === 1) disjointReceiver.add(2);
			return false;
		},
		keys() {},
	}) && disjointCalls.join(",") === "1,2",
);

const duplicateOther = {
	size: 0,
	has() {
		return false;
	},
	keys() {
		return [1, 1, 3, 3].values();
	},
};
check(
	"Set symmetric difference canonical dedupe",
	[...new Set([1, 2]).symmetricDifference(duplicateOther)].join(",") === "2,3",
);

const negativeZeroOther = {
	size: 0,
	has() {
		return false;
	},
	keys() {
		return [-0].values();
	},
};
const zeroUnion = new Set().union(negativeZeroOther);
check(
	"Set composition canonicalizes negative zero",
	zeroUnion.size === 1 && 1 / zeroUnion.values().next().value === Infinity,
);

const closeMarker = { close: true };
let closeResult;
try {
	new Set([1]).isSupersetOf({
		size: 0,
		has() {
			return false;
		},
		keys() {
			return {
				next() {
					return { done: false, value: 9 };
				},
				return() {
					throw closeMarker;
				},
			};
		},
	});
} catch (error) {
	closeResult = error;
}
check("Set predicate normal iterator close propagates", closeResult === closeMarker);

class SetSubclass extends Set {}
const subclassResult = new SetSubclass([1]).union(new Set([2]));
check(
	"Set composition result ignores species",
	Object.getPrototypeOf(subclassResult) === Set.prototype &&
		[...subclassResult].join(",") === "1,2",
);

console.log("MODE " + (mutablePrimordials ? "mutable" : "locked"));
console.log("RESULT " + passed + "/" + total);
