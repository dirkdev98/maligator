"use strict";

function caller(value) {
	return middle(value);
}
function middle(value) {
	if (value === undefined) return;
	later(value);
}
function later(value) {
	if (value === true) throw new Error("later");
}
globalThis.result = caller(globalThis.input);

function argumentCaller(value) {
	return argumentMiddle(value);
}
function argumentMiddle(value) {
	if (value === undefined) return value;
	return argumentLater(value);
}
function argumentLater(value) {
	return value + 1;
}
globalThis.argumentResult = argumentCaller(globalThis.input);
