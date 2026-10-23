"use strict";

let checks = 0;
function ok(name, condition) {
	if (!condition) throw new Error("entry-pair-parameters failure: " + name);
	checks++;
}

// Each iterable arrives as a parameter, so only the runtime cursor knows its kind.
function describePairs(iterable) {
	const parts = [];
	for (const [first, second] of iterable)
		parts.push(String(first) + "=" + String(second));
	return parts.join(",");
}

function describeNested(iterable) {
	const parts = [];
	for (const [key, [first, second]] of iterable)
		parts.push(key + ":" + first + "/" + second);
	return parts.join(",");
}

function* generatedPairs() {
	yield [1, 2];
	yield "xy";
}

function sumPairs(pairs) {
	let total = 0;
	for (const [first, second] of pairs) total += first * second;
	return total;
}

const intrinsicArrayIterator = Array.prototype[Symbol.iterator];

ok(
	"Map pairs",
	describePairs(
		new Map([
			["a", 1],
			["b", 2],
		]),
	) === "a=1,b=2",
);
ok("Set entry pairs", describePairs(new Set([7]).entries()) === "7=7");
ok("Array entry pairs", describePairs(["p", "q"].entries()) === "0=p,1=q");
ok("generator pairs", describePairs(generatedPairs()) === "1=2,x=y");
ok(
	"array of mixed pairs",
	describePairs([[1, 2], [3], [4, 5, 6], "ab", new Map([[8, 9]]), [, 10]]) ===
		"1=2,3=undefined,4=5,a=b,8,9=undefined,undefined=10",
);
class PairList extends Array {}
const ownIterator = [1, 2];
ownIterator[Symbol.iterator] = function* () {
	yield "own";
	yield "iterator";
};
ok(
	"pairs with their own iteration",
	describePairs([PairList.of(11, 12), ownIterator]) === "11=12,own=iterator",
);
ok(
	"nested pairs",
	describeNested(new Map([["m", [1, 2]]])) +
		";" +
		describeNested(Object.entries({ o: "xy" })) ===
		"m:1/2;o:x/y",
);

const growing = [[1, 2]];
const grown = [];
for (const [first, second] of growing) {
	grown.push(first + second);
	if (growing.length < 3) growing.push([first + 1, second + 1]);
}
ok("array growth during pairs", grown.join() === "3,5,7");

const shrinking = [
	[1, 2],
	[3, 4],
	[5, 6],
];
const kept = [];
for (const [first] of shrinking) {
	kept.push(first);
	shrinking.length = 1;
}
ok("array truncation during pairs", kept.join() === "1");

const gc = globalThis.__mal_collect_garbage ?? (() => {});
const retained = new Map();
const pairs = [];
for (let i = 0; i < 64; i++) {
	retained.set({ index: i }, { value: i * 2 });
	pairs.push([{ index: i }, { value: i * 3 }]);
}
let collected = 0;
for (let round = 0; round < 4; round++) {
	for (const [key, value] of retained) {
		gc();
		collected += value.value - key.index;
	}
	for (const [key, value] of pairs) collected += value.value - key.index;
}
ok("pairs survive collection", collected === 4 * (2016 + 4032));

let total = 0;
for (let i = 0; i < 200; i++)
	total += sumPairs([
		[i, 2],
		[1, i],
	]);
ok("repeated small pair arrays", total === 3 * 19900);

let thrown;
try {
	describePairs([[1, 2], null]);
} catch (error) {
	thrown = error;
}
ok("non-iterable element throws", thrown instanceof TypeError);

// Later checks break the method protector for the rest of the process.
const holeyPairs = [[1, 2]];
holeyPairs[2] = [3, 4];
Array.prototype[1] = ["proto", "pair"];
const holeOuter = describePairs(holeyPairs);
delete Array.prototype[1];
ok("array hole reads the prototype", holeOuter === "1=2,proto=pair,3=4");

const holeyPair = [5, , 6];
Array.prototype[1] = "inherited";
const holeInner = describePairs([holeyPair]);
delete Array.prototype[1];
ok("pair hole reads the prototype", holeInner === "5=inherited");

// Outer arrays keep the intrinsic iterator, so only the pair protocol changes.
Array.prototype[Symbol.iterator] = function () {
	return intrinsicArrayIterator.call(this.length === 2 ? [this[1], this[0]] : this);
};
let patchedArrayPairs;
let patchedMapPairs;
try {
	patchedArrayPairs = describePairs([[1, 2]]);
	patchedMapPairs = describePairs(new Map([["k", "v"]]));
} finally {
	Array.prototype[Symbol.iterator] = intrinsicArrayIterator;
}
ok("pairs observe patched array iteration", patchedArrayPairs === "2=1");
ok("Map pairs observe patched array iteration", patchedMapPairs === "v=k");

let returns = 0;
Object.defineProperty(Object.prototype, "return", {
	configurable: true,
	value() {
		returns++;
		return {};
	},
});
try {
	describePairs([[1, 2, 3]]);
	describePairs(new Map([["k", "v"]]));
} finally {
	delete Object.prototype.return;
}
ok("inherited return observes pair closes", returns === 2);

console.log("entry-pair-parameters PASS " + checks + "/" + checks);
