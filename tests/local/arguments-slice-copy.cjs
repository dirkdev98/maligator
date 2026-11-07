// Copies of `arguments` through the builtin slice, next to the cases that must still
// observe a real arguments object.

const lines = [];

function all() {
	return Array.prototype.slice.call(arguments);
}
function tail() {
	return [].slice.call(arguments, 1);
}
function pastTheEnd() {
	return Array.prototype.slice.call(arguments, 5);
}
function strictCopy() {
	"use strict";
	return Array.prototype.slice.call(arguments, 2);
}
lines.push(
	JSON.stringify([
		all(1, "a", null),
		all(),
		tail(1, 2, 3),
		tail(),
		pastTheEnd(1, 2),
		strictCopy(1, 2, 3, 4),
	]),
);

// Indirect eval keeps these functions sloppy, so their arguments objects map the formals.
const writtenFormal = (0, eval)(`(function writtenFormal(a, b) {
	a = 10;
	return Array.prototype.slice.call(arguments);
})`);
const sloppyCopy = (0, eval)(`(function sloppyCopy(a, b) {
	return [].slice.call(arguments, 1);
})`);
function strictWrittenFormal(a, b) {
	"use strict";
	a = 10;
	return Array.prototype.slice.call(arguments);
}
lines.push(
	JSON.stringify([writtenFormal(1, 2), strictWrittenFormal(1, 2), sloppyCopy(1, 2, 3)]),
);

function lengthAndCopy() {
	return `${arguments.length} ${Array.prototype.slice.call(arguments).join("|")} ${arguments[0]}`;
}
lines.push(lengthAndCopy("x", "y"));

function freshCopies() {
	const first = [].slice.call(arguments);
	const second = [].slice.call(arguments);
	first.push("more");
	return `${first.length} ${second.length} ${first !== second} ${Array.isArray(first)}`;
}
lines.push(freshCopies(1, 2));

function shadowedArray() {
	const Array = { prototype: { slice: { call: () => "shadowed" } } };
	return Array.prototype.slice.call(arguments);
}
lines.push(shadowedArray(1));

function arrowCopy() {
	const inner = () => Array.prototype.slice.call(arguments);
	return inner(9).join(",");
}
lines.push(arrowCopy(4, 5));

function optionalCopy() {
	return Array.prototype.slice.call(arguments)?.length;
}
lines.push(String(optionalCopy(1, 2, 3)));

let total = 0;
for (let round = 0; round < 2000; round++)
	total += all(round, 1).length + tail(round, 2, 3).length;
lines.push(`total ${total}`);

console.log(lines.join("\n"));
