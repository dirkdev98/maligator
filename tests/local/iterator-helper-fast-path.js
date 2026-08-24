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

const arrayEntries = [7, 8].entries().toArray();
assert(
	arrayEntries.length === 2 &&
		arrayEntries[0].join(":") === "0:7" &&
		arrayEntries[1].join(":") === "1:8",
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
