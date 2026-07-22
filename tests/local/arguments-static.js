function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function count() {
	return arguments.length;
}
function atTwo() {
	return arguments[2];
}
function severalSnapshots() {
	return (
		arguments[2] * 100 +
		arguments[0] * 10 +
		arguments.length +
		arguments[2] -
		arguments[2] +
		arguments.length -
		arguments.length
	);
}
function repeatedSnapshots() {
	const first = arguments[0] === undefined ? 7 : arguments[0];
	const fifth = arguments[4] === undefined ? 3 : arguments[4];
	return (
		arguments.length * 1000 +
		arguments.length * 100 +
		first * 10 +
		(arguments[0] === undefined ? 0 : arguments[0]) +
		fifth
	);
}
function defaultFromArguments(value = arguments.length === 0 ? 9 : arguments[0]) {
	return value + arguments.length + (arguments[0] === undefined ? 0 : arguments[0]);
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
function* repeatedGenerator() {
	const second = arguments[1] === undefined ? 4 : arguments[1];
	yield (
		arguments.length * 10 +
			arguments.length +
			second +
			(arguments[1] === undefined ? 0 : arguments[1])
	);
}
async function asyncCount() {
	const before = arguments.length;
	await 0;
	return before + arguments.length;
}
async function asyncIndex() {
	const before = arguments[2];
	await 0;
	return before + arguments[2] + arguments.length;
}

assert(count(1, 2, 3) === 3, "count");
assert(atTwo(1, 2, 3) === 3, "constant index");
assert(atTwo(1) === undefined, "out of range");
assert(severalSnapshots(4, 5, 6) === 643, "multiple entry snapshots");
assert(repeatedSnapshots() === 73, "omitted repeated snapshots");
assert(repeatedSnapshots(2, 3, 4, 5, 6) === 5528, "wide repeated snapshots");
assert(defaultFromArguments() === 9, "omitted default parameter");
assert(defaultFromArguments(7) === 15, "provided default parameter");
assert(withRest(1, 2, 3) === 33, "rest parameter");
assert(escaped(4, 5) === 24, "escape fallback");
assert(mutated(1) === 9, "mutation fallback");
assert(lexicalArrow(2)(5) === 4, "lexical arrow lifetime");
assert(nested(3) === 5, "nested ownership");
assert(evalArguments(4, 6) === 6, "direct eval");
assert(countGenerator(1, 2, 3).next().value === 3, "generator count");
assert(indexGenerator(8).next().value === 8, "generator index");
assert(repeatedGenerator().next().value === 4, "omitted repeated generator");
assert(repeatedGenerator(1, 6).next().value === 34, "wide repeated generator");

const sloppy = (0, eval)(
	"(function sloppy(){ return arguments.callee === sloppy && arguments[0] === 4; })",
);
assert(sloppy(4), "sloppy arguments.callee");

asyncCount(1, 2, 3).then((value) => {
	assert(value === 6, "async count lifetime");
	asyncIndex(1, 2, 4).then((indexValue) => {
		assert(indexValue === 11, "async index lifetime");
		console.log("arguments-static PASS");
	});
});
