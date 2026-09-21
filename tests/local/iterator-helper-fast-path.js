function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const mappedIndexes = [];
const chained = Iterator.from([1, 2, 3, 4, 5, 6].values())
	.map((value, index) => {
		mappedIndexes.push(index);
		return value * 3;
	})
	.filter((value) => value % 2 === 0)
	.drop(1)
	.take(2)
	.flatMap((value) => [value, value + 1])
	.toArray();
assert(chained.join(",") === "12,13,18,19", "chained helper values");
assert(mappedIndexes.join(",") === "0,1,2,3,4,5", "helper callback indexes");

const publicHelper = Iterator.from([10, 20].values()).map((value) => value + 1);
const publicFirst = publicHelper.next();
const publicSecond = publicHelper.next();
const publicDone = publicHelper.next();
assert(publicFirst !== publicSecond, "public next returns fresh result objects");
assert(
	publicFirst.value === 11 &&
		!publicFirst.done &&
		publicSecond.value === 21 &&
		!publicSecond.done &&
		publicDone.value === undefined &&
		publicDone.done,
	"public next result semantics",
);

const forwardedResult = { value: 42, done: false };
const wrapped = Iterator.from({
	next() {
		return forwardedResult;
	},
});
assert(wrapped.next() === forwardedResult, "Iterator.from forwards result identity");

const overridden = Iterator.from([2, 4, 6].values()).map((value) => value / 2);
const builtinNext = overridden.next;
let overriddenCalls = 0;
overridden.next = function () {
	overriddenCalls++;
	return builtinNext.call(this);
};
assert(overridden.toArray().join(",") === "1,2,3", "overridden next values");
assert(overriddenCalls === 4, "overridden next remains observable");

let reentrant;
let reentrantThrew = false;
reentrant = Iterator.from([1, 2].values()).map((value) => {
	try {
		reentrant.next();
	} catch (error) {
		reentrantThrew = error instanceof TypeError;
	}
	return value;
});
assert(reentrant.toArray().join(",") === "1,2", "reentrant helper continues");
assert(reentrantThrew, "reentrant next throws TypeError");

let closeCount = 0;
const closable = {
	index: 0,
	next() {
		return this.index < 4
			? { value: ++this.index, done: false }
			: { value: undefined, done: true };
	},
	return() {
		closeCount++;
		return { value: undefined, done: true };
	},
};
assert(
	Iterator.from(closable).take(1).toArray().join(",") === "1",
	"take terminal value",
);
assert(closeCount === 1, "take terminal closes underlying iterator");

const concatenated = Iterator.concat([1, 2], new Set([3, 4])).toArray();
assert(concatenated.join(",") === "1,2,3,4", "concat terminal values");

const zipped = Iterator.zip([
	[1, 2],
	[3, 4],
]).toArray();
assert(
	zipped.length === 2 && zipped[0].join(",") === "1,3" && zipped[1].join(",") === "2,4",
	"zip terminal values",
);

const keyedZipped = Iterator.zipKeyed(
	{
		prop_0: [1, 2],
		prop_1: [3],
	},
	{
		mode: "longest",
		padding: new Proxy(
			{},
			{
				get(_target, key) {
					return `pad:${key}`;
				},
			},
		),
	},
).toArray();
assert(
	Object.keys(keyedZipped[1]).join(",") === "prop_0,prop_1" &&
		keyedZipped[1].prop_0 === 2 &&
		keyedZipped[1].prop_1 === "pad:prop_1",
	"zipKeyed keeps keys and padding alive",
);

assert([1, NaN, 3].values().includes(NaN), "includes SameValueZero");
assert(![1, 2, 3].values().includes(2, 2), "includes skipped elements");
assert(
	["a", null, "b", undefined].values().join("|") === "a||b|",
	"iterator join values",
);

const chunks = [1, 2, 3, 4, 5].values().chunks(2).toArray();
assert(
	chunks.length === 3 &&
		chunks[0].join(",") === "1,2" &&
		chunks[1].join(",") === "3,4" &&
		chunks[2].join(",") === "5",
	"iterator chunks values",
);
const windows = [1, 2, 3, 4].values().windows(3).toArray();
assert(
	windows.length === 2 &&
		windows[0].join(",") === "1,2,3" &&
		windows[1].join(",") === "2,3,4",
	"iterator windows values",
);
const partialWindows = [1, 2].values().windows(3, "allow-partial").toArray();
assert(
	partialWindows.length === 1 && partialWindows[0].join(",") === "1,2",
	"iterator partial window",
);

const arrayEntries = [7, 8].entries().toArray();
assert(
	arrayEntries.length === 2 &&
		arrayEntries[0] !== arrayEntries[1] &&
		arrayEntries[0].join(":") === "0:7" &&
		arrayEntries[1].join(":") === "1:8" &&
		Object.getOwnPropertyDescriptor(arrayEntries[0], 0).writable,
	"dense Array iterator entries",
);

const sparse = [1, , 3];
const sparsePrototype = Object.create(Array.prototype);
Object.defineProperty(sparsePrototype, "1", {
	configurable: true,
	get() {
		return 9;
	},
});
Object.setPrototypeOf(sparse, sparsePrototype);
assert(sparse.values().toArray().join(",") === "1,9,3", "Array iterator inherited hole");

const typedEntries = new Uint16Array([5, 9]).entries().toArray();
assert(
	typedEntries.length === 2 &&
		typedEntries[0].join(":") === "0:5" &&
		typedEntries[1].join(":") === "1:9",
	"TypedArray iterator entries",
);

const arrayEntryLoop = [7, 11];
let arrayEntryTotal = 0;
for (const [index, value] of arrayEntryLoop.entries()) {
	arrayEntryTotal += index + value;
	if (index === 0) arrayEntryLoop.push(13);
}
assert(arrayEntryTotal === 34, "Array entry loop observes live length");

const sparseEntryLoop = [2, , 6];
const sparseEntryPrototype = Object.create(Array.prototype);
Object.defineProperty(sparseEntryPrototype, "1", {
	configurable: true,
	get() {
		return 10;
	},
});
Object.setPrototypeOf(sparseEntryLoop, sparseEntryPrototype);
let sparseEntryTotal = 0;
for (const [index, value] of sparseEntryLoop.entries()) {
	sparseEntryTotal += index + value;
}
assert(sparseEntryTotal === 21, "Array entry loop observes inherited holes");

const originalArrayEntries = Array.prototype.entries;
let overriddenArrayEntryCalls = 0;
Array.prototype.entries = function () {
	const iterator = originalArrayEntries.call(this);
	const next = iterator.next;
	iterator.next = function () {
		overriddenArrayEntryCalls++;
		return next.call(this);
	};
	return iterator;
};
let overriddenArrayEntryTotal = 0;
for (const [index, value] of [3, 5].entries()) {
	overriddenArrayEntryTotal += index + value;
}
Array.prototype.entries = originalArrayEntries;
assert(overriddenArrayEntryTotal === 9, "overridden Array entry values");
assert(overriddenArrayEntryCalls === 3, "overridden Array entry next calls");

const mapEntries = new Map([
	["a", 1],
	["b", 2],
])
	.entries()
	.toArray();
assert(
	mapEntries.length === 2 &&
		mapEntries[0].join(":") === "a:1" &&
		mapEntries[1].join(":") === "b:2",
	"Map iterator entries",
);
const setEntries = new Set([3, 4]).entries().toArray();
assert(
	setEntries.length === 2 &&
		setEntries[0].join(":") === "3:3" &&
		setEntries[1].join(":") === "4:4",
	"Set iterator entries",
);

assert(
	Iterator.from(new Set([2, 3, 4]).values())
		.map((value) => value * 2)
		.reduce((total, value) => total + value, 0) === 18,
	"Set iterator helper reduce",
);
assert(
	Iterator.from("A\ud83d\ude00B")
		.map((value) => value)
		.toArray()
		.join("|") === "A|😀|B",
	"String iterator helper code points",
);

const nativeStringIterator = String.prototype[Symbol.iterator];
let stringIteratorCalls = 0;
String.prototype[Symbol.iterator] = function () {
	stringIteratorCalls++;
	return nativeStringIterator.call(this);
};
assert(
	Iterator.from("xy").toArray().join("") === "xy",
	"Iterator.from observes an overridden String iterator",
);
assert(stringIteratorCalls === 1, "overridden String iterator call count");

console.log("iterator-helper-fast-path PASS");
