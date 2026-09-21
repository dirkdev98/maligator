const checks = [];

function check(name, passed) {
	checks.push([name, passed]);
}

function throwsSame(expected, operation) {
	try {
		operation();
		return false;
	} catch (error) {
		return error === expected;
	}
}

const object = { value: 3 };
const ordinary = [...[1, object, 5]];
check(
	"ordinary packed copy",
	ordinary.join() === "1,[object Object],5" && ordinary[1] === object,
);

const holes = [...new Array(2)];
check(
	"holes become own undefined elements",
	holes.length === 2 && 0 in holes && 1 in holes && holes[0] === undefined,
);

const frozenEmpty = Object.freeze([]);
const frozenEmptyCopy = [...frozenEmpty];
const frozenEmptyFrom = Array.from(frozenEmpty);
check(
	"frozen empty source stays iterable",
	frozenEmptyCopy.length === 0 &&
		frozenEmptyCopy !== frozenEmpty &&
		frozenEmptyFrom.length === 0 &&
		frozenEmptyFrom !== frozenEmpty,
);

let frozenIteratorGets = 0;
const frozenObserved = [];
Object.defineProperty(frozenObserved, Symbol.iterator, {
	get() {
		frozenIteratorGets++;
		return Array.prototype.values;
	},
});
Object.freeze(frozenObserved);
check(
	"frozen empty iterator getter is observed",
	[...frozenObserved].length === 0 && frozenIteratorGets === 1,
);

const arrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const originalArrayIteratorNext = arrayIteratorPrototype.next;
let overriddenNextCalls = 0;
arrayIteratorPrototype.next = function () {
	overriddenNextCalls++;
	return overriddenNextCalls === 1 ? { value: 9, done: false } : { done: true };
};
const overriddenFrozenCopy = [...frozenEmpty];
arrayIteratorPrototype.next = originalArrayIteratorNext;
check(
	"frozen empty iterator protocol override is observed",
	overriddenFrozenCopy.join() === "9" && overriddenNextCalls === 2,
);

Object.defineProperty(Array.prototype, "0", {
	configurable: true,
	get() {
		return 41;
	},
});
const inheritedCopy = [...new Array(1)];
delete Array.prototype[0];
check("inherited indexed getter remains observable", inheritedCopy[0] === 41);

let iteratorGets = 0;
const observed = [7, 8];
Object.defineProperty(observed, Symbol.iterator, {
	configurable: true,
	get() {
		iteratorGets++;
		return Array.prototype.values;
	},
});
const observedCopy = [...observed];
check(
	"iterator getter is observed once",
	observedCopy.join() === "7,8" && iteratorGets === 1,
);

const poisonedSource = [11];
let prototypeSets = 0;
Object.defineProperty(Array.prototype, "0", {
	configurable: true,
	set() {
		prototypeSets++;
	},
});
const poisonedCopy = [...poisonedSource];
delete Array.prototype[0];
check(
	"spread defines own elements",
	prototypeSets === 0 && poisonedCopy[0] === 11 && poisonedCopy.hasOwnProperty("0"),
);

const arrayLikeFailure = {};
check(
	"array-like without iterator throws",
	(() => {
		try {
			const ignored = [...{ 0: 1, length: 1 }];
			return ignored === arrayLikeFailure;
		} catch (error) {
			return error instanceof TypeError;
		}
	})(),
);

let nextGets = 0;
const custom = {
	[Symbol.iterator]() {
		let index = 0;
		return {
			get next() {
				nextGets++;
				return () =>
					index < 3 ? { value: ++index, done: false } : { value: 0, done: true };
			},
		};
	},
};
check(
	"custom iterator drains in order",
	[...custom].join() === "1,2,3" && nextGets === 1,
);

const stepFailure = {};
let returnGets = 0;
const throwing = {
	[Symbol.iterator]() {
		return {
			next() {
				throw stepFailure;
			},
			get return() {
				returnGets++;
				return () => ({ done: true });
			},
		};
	},
};
check(
	"step failure propagates without closing",
	throwsSame(stepFailure, () => [...throwing]) && returnGets === 0,
);

check(
	"Set and astral string",
	[...new Set([2, 4])].join() === "2,4" && [..."A😀"].length === 2,
);

for (const [name, passed] of checks) {
	if (!passed) console.log("FAIL: " + name);
}
console.log(
	"array-spread-iterable PASS " +
		checks.filter(([, passed]) => passed).length +
		"/" +
		checks.length,
);
