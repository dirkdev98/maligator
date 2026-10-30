let passed = 0;
function check(actual, expected, label) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label);
	passed++;
}

function invoke(callback, ...args) {
	return (value) => callback(value, ...args);
}
function collect(...args) {
	return args;
}
const heap = { value: 42 };
const captured = invoke(collect, heap, "tail");
check(captured("first"), ["first", heap, "tail"], "captured rest survives its owner");
check(captured("second"), ["second", heap, "tail"], "captured rest is reusable");
check(collect(1, 2, ...[]), [1, 2], "empty suffix");
check(collect(1, 2, ...[3, 4]), [1, 2, 3, 4], "multiple prefixes");
check(collect(1, ..."💚x"), [1, "💚", "x"], "string iteration");
check(collect(1, ...[2], 3, ...[4]), [1, 2, 3, 4], "multiple spread fallback");
check(Math.max(-1, 7, ...[3, 4]), 7, "known builtin prefix");
const receiver = {
	name: "receiver",
	collect(...args) {
		return [this.name, ...args];
	},
};
check(receiver.collect(1, ...[2]), ["receiver", 1, 2], "method receiver");
check(receiver.collect?.(1, ...[2]), ["receiver", 1, 2], "optional method receiver");
let effects = 0;
const absent = null;
check(absent?.collect(++effects, ...[2]), undefined, "optional base short circuit");
const missing = undefined;
check(missing?.(++effects, ...[2]), undefined, "optional call short circuit");
check(effects, 0, "short circuit precedes arguments");

const order = [];
const iterable = {
	get [Symbol.iterator]() {
		order.push("iterator getter");
		return function () {
			let index = 0;
			return {
				next() {
					order.push("next" + index);
					return index++ === 0 ? { value: heap, done: false } : { done: true };
				},
			};
		};
	},
};
function prefix() {
	order.push("prefix");
	return { alive: 9 };
}
function suffix() {
	order.push("suffix");
	return iterable;
}
const target = {
	get call() {
		order.push("callee");
		return collect;
	},
};
check(
	target.call(prefix(), ...suffix()),
	[{ alive: 9 }, heap],
	"prefix roots across iterator calls",
);
check(
	order,
	["callee", "prefix", "suffix", "iterator getter", "next0", "next1"],
	"evaluation order",
);
order.length = 0;
try {
	0(prefix(), ...suffix());
} catch (error) {
	check(error instanceof TypeError, true, "noncallable error");
}
check(
	order,
	["prefix", "suffix", "iterator getter", "next0", "next1"],
	"iteration precedes callability",
);

let calls = 0;
const failing = {
	[Symbol.iterator]() {
		return {
			next() {
				throw new Error("iterator failed");
			},
		};
	},
};
try {
	(() => calls++)(heap, ...failing);
} catch (error) {
	check(error.message, "iterator failed", "iterator exception");
}
check(calls, 0, "throw prevents call");
check(collect(heap, ...[1]), [heap, 1], "argument stack restored after throw");
const overridden = [1, 2];
overridden[Symbol.iterator] = function* () {
	yield 7;
	yield 8;
};
check(collect(3, ...overridden), [3, 7, 8], "custom array iterator");
const sparse = [, 2];
check(collect(3, ...sparse), [3, undefined, 2], "array holes");
let elementReads = 0;
const counted = {
	get value() {
		return ++elementReads;
	},
};
const sharedLiteral = [counted.value, 2];
check(
	[collect(...sharedLiteral), collect(0, ...sharedLiteral), elementReads],
	[[1, 2], [0, 1, 2], 1],
	"literal shared by two spreads",
);
const labelled = [1, 2];
labelled.label = "own data";
check(collect(0, ...labelled), [0, 1, 2], "array with other own properties");
class Pair extends Array {
	*[Symbol.iterator]() {
		yield "subclass";
	}
}
check(collect(0, ...Pair.from([1, 2])), [0, "subclass"], "array subclass iterator");

// After spreads took the intact protocol, a patch must reach later spreads wherever the
// intrinsics are mutable, and leave them intact where they are locked.
const originalIterator = Array.prototype[Symbol.iterator];
const replacementIterator = function* () {
	yield "patched";
};
try {
	Array.prototype[Symbol.iterator] = replacementIterator;
} catch {}
check(
	collect(0, ...[1, 2]),
	Array.prototype[Symbol.iterator] === replacementIterator ? [0, "patched"] : [0, 1, 2],
	"patched Array.prototype iterator",
);
try {
	Array.prototype[Symbol.iterator] = originalIterator;
} catch {}
const arrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const originalNext = arrayIteratorPrototype.next;
const replacementNext = () => ({ done: true, value: undefined });
try {
	arrayIteratorPrototype.next = replacementNext;
} catch {}
check(
	collect(0, ...[1, 2]),
	arrayIteratorPrototype.next === replacementNext ? [0] : [0, 1, 2],
	"patched ArrayIterator next",
);
try {
	arrayIteratorPrototype.next = originalNext;
} catch {}

console.log(`trailing-spread-calls PASS ${passed}`);
