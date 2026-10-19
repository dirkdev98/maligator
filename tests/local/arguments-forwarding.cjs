"use strict";
// Calls that pass `arguments` on through `apply` or spread.

const lines = [];

function target(a, b, c) {
	return `${this?.name} ${a} ${b} ${c} ${arguments.length}`;
}

function forward() {
	return target.apply(this, arguments);
}
lines.push(forward.call({ name: "bound" }, 1, 2, 3), forward(), forward(1));

function once(fn) {
	let called = false;
	let value;
	return function () {
		if (called) return value;
		called = true;
		return (value = fn.apply(this, arguments));
	};
}
const add = once((a, b) => a + b);
lines.push(`once ${add(1, 2)} ${add(5, 5)}`);

function restore(fn, obj) {
	var props = new Array(arguments.length - 2);
	var vals = new Array(arguments.length - 2);
	for (var i = 0; i < props.length; i++) {
		props[i] = arguments[i + 2];
		vals[i] = obj[props[i]];
	}
	return function () {
		for (var i = 0; i < props.length; i++) obj[props[i]] = vals[i];
		return fn.apply(this, arguments);
	};
}
const request = { baseUrl: "/", next: null };
const done = restore(
	(error) => `${error} ${request.baseUrl}`,
	request,
	"baseUrl",
	"next",
);
request.baseUrl = "/changed";
lines.push(`restore ${done("none")}`);

const custom = {
	apply(thisArg, list) {
		let callee;
		try {
			callee = list.callee;
		} catch (error) {
			callee = error.name;
		}
		return `${Object.prototype.toString.call(list)} ${Array.isArray(list)} ${list.length} ${list[0]} ${callee}`;
	},
};
function viaCustom() {
	return custom.apply(null, arguments);
}
lines.push(`custom ${viaCustom("first", "second")}`);

let kept;
const keeper = {
	apply(thisArg, list) {
		kept = list;
		return list.length;
	},
};
function keep() {
	return keeper.apply(null, arguments);
}
const keptLength = keep("x", "y");
kept[0] = "changed";
lines.push(`kept ${keptLength} ${kept[0]} ${kept.length}`);

function spread() {
	return target(...arguments);
}
lines.push(`spread ${spread(7, 8)}`);

function inner(...values) {
	let sum = 0;
	for (const { value } of values) sum += value;
	return sum;
}
function middle() {
	return inner.apply(null, arguments);
}
function outer() {
	const padding = [1, 2, 3].map((value) => ({ value }));
	return middle.apply(null, arguments) + padding.length;
}
let total = 0;
for (let round = 0; round < 2000; round++) total += outer({ value: round }, { value: 1 });
lines.push(`total ${total}`);

function nonCallable() {
	const holder = { apply: Function.prototype.apply };
	try {
		return holder.apply(null, arguments);
	} catch (error) {
		return error.name;
	}
}
lines.push(`noncallable ${nonCallable(1)}`);

console.log(lines.join("\n"));
