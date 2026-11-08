// Reads through a local `arguments` alias, next to the aliases that must still observe
// a real arguments object.

const lines = [];

function list() {
	var result = null;
	var items = arguments;
	for (var i = items.length - 1; i >= 0; i--) result = { car: items[i], cdr: result };
	return result;
}
function sum() {
	"use strict";
	const args = arguments;
	let total = 0;
	for (let i = 0; i < args.length; i++) total += args[i];
	return total;
}
function firstAndCount() {
	let args = arguments,
		count = args.length;
	return `${args[0]} ${count}`;
}
lines.push(
	JSON.stringify([
		list(1, 2, 3),
		list(),
		sum(1, 2, 3, 4),
		sum(),
		firstAndCount("x", "y"),
	]),
);

// Indirect eval keeps these functions sloppy, so their arguments objects map the formals.
const mappedFormalWrite = (0, eval)(`(function mappedFormalWrite(x) {
	var args = arguments;
	x = 2;
	return args[0];
})`);
const aliasElementWrite = (0, eval)(`(function aliasElementWrite(x) {
	var args = arguments;
	args[0] = 9;
	return x + " " + arguments[0];
})`);
const argumentsReassigned = (0, eval)(`(function argumentsReassigned() {
	var args = arguments;
	arguments = [5];
	return args.length + " " + arguments[0];
})`);
function strictFormalWrite(x) {
	"use strict";
	var args = arguments;
	x = 2;
	return args[0];
}
lines.push(
	JSON.stringify([
		mappedFormalWrite(1),
		aliasElementWrite(1),
		argumentsReassigned(1, 2, 3),
		strictFormalWrite(1),
	]),
);

function identity() {
	var args = arguments;
	return args === arguments && Object.prototype.toString.call(args);
}
function readBeforeDeclaration() {
	var seen = typeof args;
	var args = arguments;
	return `${seen} ${args.length}`;
}
function aliasReassigned() {
	var args = arguments;
	args = [7];
	return `${args[0]} ${arguments.length}`;
}
function readInArrow() {
	var args = arguments;
	return (() => args[1])();
}
function passedOn() {
	var args = arguments;
	return Array.from(args).join(",");
}
function redeclared() {
	var args = arguments;
	var args;
	return args.length;
}
function declaredInBlock(flag) {
	if (flag) {
		var args = arguments;
	}
	return args === undefined ? "none" : args.length;
}
lines.push(
	JSON.stringify([
		identity(1),
		readBeforeDeclaration(1, 2),
		aliasReassigned(1, 2),
		readInArrow(1, 2),
		passedOn(1, 2, 3),
		redeclared(1, 2),
		declaredInBlock(false),
		declaredInBlock(true, 2),
	]),
);

let total = 0;
for (let round = 0; round < 2000; round++)
	total += sum(round, 1, 2) + (list(round, 1) === null ? 0 : 1);
lines.push(`total ${total}`);

console.log(lines.join("\n"));
