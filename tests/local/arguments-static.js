function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function count() {
	return arguments.length;
}
function atTwo() {
	return arguments[2];
}
function defaultFromArguments(value = arguments[0]) {
	return value;
}
function withRest(...rest) {
	return arguments.length * 10 + rest.length;
}
function escaped() {
	const value = arguments;
	return value.length * 10 + value[0];
}
function mutated() {
	arguments[0] = 9;
	return arguments[0];
}
function lexicalArrow(value) {
	return () => arguments[0] + value;
}
function nested(value) {
	function inner() {
		return arguments.length;
	}
	return value + inner(1, 2);
}
function evalArguments() {
	return eval("arguments[1]");
}
function* countGenerator() {
	yield arguments.length;
}
function* indexGenerator() {
	yield arguments[0];
}
async function asyncCount() {
	const before = arguments.length;
	await 0;
	return before + arguments.length;
}

assert(count(1, 2, 3) === 3, "count");
assert(atTwo(1, 2, 3) === 3, "constant index");
assert(atTwo(1) === undefined, "out of range");
assert(defaultFromArguments(7) === 7, "default parameter");
assert(withRest(1, 2, 3) === 33, "rest parameter");
assert(escaped(4, 5) === 24, "escape fallback");
assert(mutated(1) === 9, "mutation fallback");
assert(lexicalArrow(2)(5) === 4, "lexical arrow lifetime");
assert(nested(3) === 5, "nested ownership");
assert(evalArguments(4, 6) === 6, "direct eval");
assert(countGenerator(1, 2, 3).next().value === 3, "generator count");
assert(indexGenerator(8).next().value === 8, "generator index");

const sloppy = (0, eval)(
	"(function sloppy(){ return arguments.callee === sloppy && arguments[0] === 4; })",
);
assert(sloppy(4), "sloppy arguments.callee");

asyncCount(1, 2, 3).then((value) => {
	assert(value === 6, "async count lifetime");
	console.log("arguments-static PASS");
});
