let checks = 0;

function check(condition, message) {
	if (!condition) throw new Error("FAIL " + message);
	checks++;
}

function strictEqual(left, right) {
	return left === right;
}

function strictNotEqual(left, right) {
	return left !== right;
}

function identity(value) {
	return value;
}

const f64One = identity(0.5 + 0.5);
check(strictEqual(1, f64One), "mixed int32/f64 equality");
check(strictEqual(0, -0), "positive and negative zero equality");
check(strictEqual(-0, 0), "negative and positive zero equality");
check(strictNotEqual(NaN, NaN), "NaN inequality");
check(strictEqual(1.5, 1.5), "f64 equality");
check(strictNotEqual(1.5, 2.5), "f64 inequality");

const object = { value: 1 };
const otherObject = { value: 1 };
check(strictEqual(object, object), "object identity");
check(strictNotEqual(object, otherObject), "distinct objects");
check(strictEqual(null, null), "null identity");
check(strictEqual(undefined, undefined), "undefined identity");
check(strictNotEqual(null, undefined), "null and undefined differ");
check(strictEqual(true, true), "boolean identity");
check(strictNotEqual(true, false), "boolean difference");

const bigint = BigInt("123456789012345678901234567890");
const equalBigint = BigInt("123456789012345678901234567890");
const otherBigint = BigInt("123456789012345678901234567891");
check(strictEqual(bigint, bigint), "BigInt identity");
check(strictEqual(bigint, equalBigint), "distinct equal BigInt values");
check(strictNotEqual(bigint, otherBigint), "different BigInt values");
check(strictNotEqual(1n, 1), "BigInt and Number differ");

const symbol = Symbol("strict");
check(strictEqual(symbol, symbol), "Symbol identity");
check(strictNotEqual(symbol, Symbol("strict")), "distinct Symbols");

const defaultMarker = {};
function defaultArgument(value = defaultMarker) {
	return strictEqual(value, defaultMarker);
}
function isNullish(value) {
	return strictEqual(value, null) || strictEqual(value, undefined);
}
check(defaultArgument(), "omitted default argument");
check(defaultArgument(undefined), "undefined default argument");
check(!defaultArgument(null), "null does not trigger default");
check(isNullish(null), "nullish null");
check(isNullish(undefined), "nullish undefined");
check(!isNullish(false), "boolean is not nullish");

const pointerString = "pointer-" + identity("identical");
check(strictEqual(pointerString, pointerString), "pointer-identical cons string");

const flatLeft = JSON.parse('"flat-value"');
const flatRight = JSON.parse('"flat-value"');
const flatOther = JSON.parse('"flat-other"');
check(strictEqual(flatLeft, flatRight), "distinct flat strings");
check(strictNotEqual(flatLeft, flatOther), "different flat strings");

const dependentParent =
	"left".repeat(2048) + "dependent".repeat(1024) + "right".repeat(2048);
const dependentStart = 4 * 2048;
const dependentEnd = dependentStart + 9 * 1024;
const dependentLeft = dependentParent.slice(dependentStart, dependentEnd);
const dependentRight = dependentParent.slice(dependentStart, dependentEnd);
check(strictEqual(dependentLeft, dependentRight), "distinct dependent strings");

const consSuffix = identity("value");
const consLeft = "cons-prefix-" + consSuffix;
const consRight = "cons-prefix-" + consSuffix;
const consOther = "cons-prefix-" + identity("other");
check(strictEqual(consLeft, consRight), "distinct cons strings");
check(strictNotEqual(consLeft, consOther), "different cons strings");

let directHits = 0;
for (let i = 0; i < 5000; i++) {
	if (object === object) directHits++;
}
check(strictEqual(directHits, 5000), "direct strict loop");

let stringHits = 0;
for (let i = 0; i < 64; i++) {
	if (consLeft === consRight) stringHits++;
}
check(strictEqual(stringHits, 64), "string fallback loop");

console.log("interpreter-strict-equality PASS " + checks);
