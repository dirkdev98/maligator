function boxedLt(left, right, gate) {
	const a = String(left);
	const b = String(right);
	gate();
	return a < b;
}
function boxedLe(left, right, gate) {
	const a = String(left);
	const b = String(right);
	gate();
	return a <= b;
}
function boxedGt(left, right, gate) {
	const a = String(left);
	const b = String(right);
	gate();
	return a > b;
}
function boxedGe(left, right, gate) {
	const a = String(left);
	const b = String(right);
	gate();
	return a >= b;
}
function boxedEq(left, right, gate) {
	const a = String(left);
	const b = String(right);
	gate();
	return a == b;
}
function boxedNe(left, right, gate) {
	const a = String(left);
	const b = String(right);
	gate();
	return a != b;
}
function boxedStrictEq(left, right, gate) {
	const a = String(left);
	const b = String(right);
	gate();
	return a === b;
}
function boxedStrictNe(left, right, gate) {
	const a = String(left);
	const b = String(right);
	gate();
	return a !== b;
}
globalThis.stringKernels = [
	boxedLt,
	boxedLe,
	boxedGt,
	boxedGe,
	boxedEq,
	boxedNe,
	boxedStrictEq,
	boxedStrictNe,
];
const gc = globalThis.__mal_collect_garbage ?? (() => {});
const pairs = [
	["", ""],
	["", "a"],
	["ab", "abc"],
	["abc", "ab"],
	["é", "€"],
	["\ud800", "\ud801"],
	["\udfff", "😀"],
	["x".repeat(128) + "é", ("!" + "x".repeat(128) + "é" + "!").slice(1, -1)],
	["x".repeat(512) + "z", "x".repeat(512) + "a"],
];
for (const [left, right] of pairs) {
	const trace = [];
	const a = {
		toString() {
			trace.push("a");
			return left;
		},
	};
	const b = {
		toString() {
			trace.push("b");
			return right;
		},
	};
	const results = [];
	for (const kernel of globalThis.stringKernels) results.push(kernel(a, b, gc));
	console.log(results.join(","), trace.join(""));
}
const trace = [];
function value(name, result) {
	return {
		[Symbol.toPrimitive](hint) {
			trace.push(name + ":" + hint);
			gc();
			return result;
		},
	};
}
console.log(
	value("left", "2") < value("right", 10),
	"2" == value("equal", 2),
	"2" === value("strict", 2),
	trace.join(","),
);
