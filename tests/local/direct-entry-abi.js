"use strict";

let sideEffects = 0;

function scalarArgument(value) {
	let total = 0;
	for (let index = 0; index < 24; index++) total += value * index;
	return total;
}

function scalarResult(flag) {
	for (let index = 0; index < 24; index++) sideEffects += index;
	if (flag) return 41;
	return 42;
}

function scalarLeaf(value, flag) {
	return flag ? value * 2 : value - 3;
}

function scalarMiddle(value, flag) {
	return scalarLeaf(value + 1, !flag);
}

function scalarRoot(value) {
	return scalarMiddle(value, true) + scalarMiddle(value + 2, false);
}

function makeCaptured(base) {
	return function captured(value) {
		let total = base;
		for (let index = 0; index < 24; index++) total += value;
		return total;
	};
}

function observesArguments(first) {
	return `${arguments.length}:${first}:${arguments[2]}`;
}

function throwsFromScalar(value) {
	for (let index = 0; index < 24; index++) sideEffects += index;
	if (value < 0) throw new Error(`negative:${value}`);
	return value;
}

const ranks = new Int32Array(3);
ranks[0] = -4;
ranks[1] = 7;
ranks[2] = 7;

function compareTypedArrayKinds(leftIndex, rightIndex) {
	const left = ranks[leftIndex];
	const right = ranks[rightIndex];
	return [
		left == undefined,
		left === undefined,
		left != undefined,
		left !== undefined,
		left < right,
		left <= right,
		left > right,
		left >= right,
	];
}

const captured = makeCaptured(7);
let thrown;
try {
	throwsFromScalar(-3);
} catch (error) {
	thrown = error.message;
}

console.log(
	JSON.stringify({
		scalarArgument: scalarArgument(3),
		scalarResults: [scalarResult(true), scalarResult(false)],
		scalarChain: scalarRoot(5),
		captured: captured(5),
		arguments: observesArguments(1, 2, 3, 4),
		thrown,
		sideEffects,
		typedArrayKinds: [
			compareTypedArrayKinds(0, 1),
			compareTypedArrayKinds(1, 2),
			compareTypedArrayKinds(9, 1),
			compareTypedArrayKinds(1, 9),
			compareTypedArrayKinds(9, 10),
		],
	}),
);
