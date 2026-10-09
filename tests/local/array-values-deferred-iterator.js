"use strict";

// Every scenario before the last runs while no built-in prototype has been
// mutated, so array for-of loops may iterate without allocating their
// %ArrayIterator%. The last scenario breaks that protector mid-loop.
const results = [];
function check(name, ok) {
	results.push([name, ok]);
}

function sum(values) {
	let total = 0;
	for (const value of values) total += value;
	return total;
}

function firstAbove(values, limit) {
	for (const value of values) {
		if (value > limit) return value;
	}
	return -1;
}

function collectUntilThrow(values) {
	const seen = [];
	try {
		for (const value of values) {
			if (value === "stop") throw new Error("stop");
			seen.push(value);
		}
	} catch (error) {
		seen.push(error.message);
	}
	return seen.join(",");
}

function readHoles() {
	const values = [1, , 3];
	values[6] = 7;
	const seen = [];
	for (const value of values) seen.push(value === undefined ? "hole" : value);
	return seen.join(",");
}

function growWhileIterating() {
	const values = [1, 2];
	const seen = [];
	for (const value of values) {
		seen.push(value);
		if (values.length < 5) values.push(value * 10);
	}
	return seen.join(",");
}

function shrinkWhileIterating() {
	const values = [1, 2, 3, 4];
	const seen = [];
	for (const value of values) {
		seen.push(value);
		values.length = 2;
	}
	return seen.join(",");
}

function nestedProducts(rows) {
	let total = 0;
	for (const row of rows) {
		for (const cell of row) total += cell * row.length;
	}
	return total;
}

function depthSum(tree) {
	let total = 0;
	for (const child of tree) total += Array.isArray(child) ? depthSum(child) : child;
	return total;
}

function iterateAnything(source) {
	const seen = [];
	for (const value of source) seen.push(value);
	return seen.join("|");
}

function pairSums(pairs) {
	let total = 0;
	for (const [left, right] of pairs) total += left * right;
	return total;
}

function* doubled(values) {
	for (const value of values) yield value * 2;
}

function closeObservesFreshIterator() {
	const prototype = Object.getPrototypeOf([][Symbol.iterator]());
	const intrinsicNext = prototype.next;
	const seen = [];
	let observed = [];
	for (const value of [10, 20, 30, 40]) {
		seen.push(value);
		if (value === 10) {
			// The loop captured the intrinsic next before this replacement.
			prototype.next = () => ({ done: true, value: undefined });
			prototype.return = function () {
				observed = [Object.prototype.toString.call(this), intrinsicNext.call(this).value];
				return {};
			};
		}
		if (value === 30) break;
	}
	prototype.next = intrinsicNext;
	delete prototype.return;
	return [seen.join(","), ...observed].join(";");
}

check("dense sum", sum([1, 2, 3, 4]) === 10);
check("empty sum", sum([]) === 0);
check("return closes", firstAbove([1, 5, 9], 4) === 5 && firstAbove([1], 4) === -1);
check("throw closes", collectUntilThrow(["a", "b", "stop", "c"]) === "a,b,stop");
check(
	"holes read through the prototype chain",
	readHoles() === "1,hole,3,hole,hole,hole,7",
);
check("growth is visited", growWhileIterating() === "1,2,10,20,100");
check("shrinking ends early", shrinkWhileIterating() === "1,2");
check(
	"nested loops",
	nestedProducts([
		[1, 2],
		[3, 4, 5],
	]) === 42,
);
check("recursive loops", depthSum([1, [2, [3, 4]], 5]) === 15);
check("string source", iterateAnything("ab") === "a|b");
check("Set source", iterateAnything(new Set([3, 4])) === "3|4");
class TaggedArray extends Array {
	*[Symbol.iterator]() {
		yield "tagged";
	}
}
check("subclass iterator", iterateAnything(TaggedArray.from([1, 2])) === "tagged");
const ownIterator = [1, 2];
ownIterator[Symbol.iterator] = function* () {
	yield "own";
};
check("own iterator", iterateAnything(ownIterator) === "own");
check(
	"pair destructuring",
	pairSums([
		[2, 3],
		[4, 5],
	]) === 26,
);
check("generator loop", [...doubled([1, 2, 3])].join(",") === "2,4,6");
let churn = 0;
for (let round = 0; round < 2000; round++)
	churn += sum([round, round + 1, { length: 0 }.length]);
check("allocation churn", churn === 4000000);
check(
	"close materializes the iterator state",
	closeObservesFreshIterator() === "10,20,30;[object Array Iterator];40",
);
check(
	"loops after the protector breaks",
	sum([5, 6]) === 11 && firstAbove([1, 8], 2) === 8,
);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
