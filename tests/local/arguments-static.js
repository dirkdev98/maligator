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
function swapCycle() {
	return arguments[1] * 10 + arguments[0];
}
function threeCycle() {
	return arguments[1] * 100 + arguments[2] * 10 + arguments[0];
}
function countOverlap() {
	return arguments.length * 10 + arguments[0];
}
function missingStatic(value) {
	value = 9;
	return arguments[0];
}
function twoMissingStatic() {
	return arguments[0] + arguments[1];
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
const recursiveCount = function recurse(remaining) {
	if (remaining === 0) return arguments.length;
	return recurse(remaining - 1, 99);
};

assert(count(1, 2, 3) === 3, "count");
assert(atTwo(1, 2, 3) === 3, "constant index");
assert(atTwo(1) === undefined, "out of range");
assert(severalSnapshots(4, 5, 6) === 643, "multiple entry snapshots");
assert(swapCycle(4, 7) === 74, "two-way snapshot cycle");
assert(threeCycle(4, 7, 8) === 784, "three-way snapshot cycle");
assert(countOverlap(6) === 16, "count snapshot overlap");
let missingReceiver;
Object.defineProperty(Object.prototype, "0", {
	configurable: true,
	get() {
		missingReceiver = this;
		return 20;
	},
});
Object.defineProperty(Object.prototype, "1", {
	configurable: true,
	get() {
		return this === missingReceiver ? 22 : -20;
	},
});
assert(missingStatic() === 20, "missing static prototype read");
missingReceiver = undefined;
assert(twoMissingStatic() === 42, "missing static reads share arguments identity");
delete Object.prototype[0];
delete Object.prototype[1];
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
assert(recursiveCount(1) === 2, "recursive snapshots");
assert(countGenerator(1, 2, 3).next().value === 3, "generator count");
assert(indexGenerator(8).next().value === 8, "generator index");
assert(repeatedGenerator().next().value === 4, "omitted repeated generator");
assert(repeatedGenerator(1, 6).next().value === 34, "wide repeated generator");

const sloppy = (0, eval)(
	"(function sloppy(){ return arguments.callee === sloppy && arguments[0] === 4; })",
);
assert(sloppy(4), "sloppy arguments.callee");

const mappedStaticSuite = (0, eval)(`(function () {
	function mappedStatic(value) {
		value = 9;
		return arguments[0];
	}
	function duplicateStatic(value, value) {
		value = 7;
		return arguments[0] * 10 + arguments[1];
	}
	function missingMapped(value) {
		value = 9;
		return arguments[0];
	}
	if (mappedStatic(3) !== 9) return "mapped";
	if (duplicateStatic(2, 3) !== 27) return "duplicate";
	Object.defineProperty(Object.prototype, "0", { configurable: true, get: function () { return 11; } });
	var missingMappedResult = missingMapped();
	delete Object.prototype[0];
	if (missingMappedResult !== 11) return "missing mapped";
	return true;
})`);
const mappedStaticResult = mappedStaticSuite();
assert(mappedStaticResult === true, "mapped static semantics: " + mappedStaticResult);

const mappedSuite = (0, eval)(`(function () {
	function descriptor(value) {
		var args = arguments;
		args[0] = 2;
		if (value !== 2) return false;
		value = 3;
		if (args[0] !== 3) return false;
		Object.defineProperty(args, "0", { configurable: false });
		value = 4;
		if (Object.getOwnPropertyDescriptor(args, "0").value !== 4) return false;
		Object.defineProperty(args, "0", { writable: false });
		value = 5;
		return args[0] === 4;
	}
	function deleted(value) { delete arguments[0]; value = 2; return arguments[0]; }
	function duplicate(value, value) { arguments[0] = 3; arguments[1] = 4; return value; }
	function missing(value) { value = 3; return Object.hasOwn(arguments, "0"); }
	function unmapped(value = 1) { arguments[0] = 4; return value; }
	function closure(value) {
		var args = arguments;
		return [function (next) { value = next; }, function () { return args[0]; }];
	}
	var pair = closure(1);
	pair[0](7);
	if (!descriptor(1)) return "descriptor";
	if (deleted(1) !== undefined) return "delete";
	if (duplicate(1, 2) !== 4) return "duplicate";
	if (missing()) return "missing";
	if (unmapped(2) !== 2) return "unmapped";
	if (pair[1]() !== 7) return "closure";
	return true;
})`);
const mappedResult = mappedSuite();
assert(mappedResult === true, "mapped arguments exotic semantics: " + mappedResult);

asyncCount(1, 2, 3).then((value) => {
	assert(value === 6, "async count lifetime");
	asyncIndex(1, 2, 4).then((indexValue) => {
		assert(indexValue === 11, "async index lifetime");
		console.log("arguments-static PASS");
	});
});
