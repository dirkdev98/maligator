"use strict";

function assertSame(actual, expected, name) {
	if (actual !== expected) {
		throw new Error(name + ": expected " + expected + ", got " + actual);
	}
}

function topLevel() {
	return "first";
}
function topLevel() {
	return "second";
}
assertSame(topLevel(), "second", "strict Script");

function strictBody() {
	function duplicate() {
		return "first";
	}
	function duplicate() {
		return "second";
	}
	return duplicate();
}
assertSame(strictBody(), "second", "strict function body");

assertSame(
	(0, eval)(
		"function duplicate(){ return 'first' } function duplicate(){ return 'second' } duplicate()",
	),
	"second",
	"sloppy indirect eval",
);
assertSame(
	eval(
		'"use strict"; function duplicate(){ return "first" } function duplicate(){ return "second" } duplicate()',
	),
	"second",
	"strict direct eval",
);

console.log("duplicate-function-declarations PASS 4/4");
