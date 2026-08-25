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
		captured: captured(5),
		arguments: observesArguments(1, 2, 3, 4),
		thrown,
		sideEffects,
	}),
);
