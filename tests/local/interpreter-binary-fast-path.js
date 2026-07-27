function repr(value) {
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "number:NaN";
		if (Object.is(value, -0)) return "number:-0";
		if (value === Infinity) return "number:Infinity";
		if (value === -Infinity) return "number:-Infinity";
		return "number:" + String(value);
	}
	if (typeof value === "bigint") return "bigint:" + String(value);
	return typeof value + ":" + String(value);
}

const add = (a, b) => a + b;
const subtract = (a, b) => a - b;
const multiply = (a, b) => a * b;
const divide = (a, b) => a / b;
const remainder = (a, b) => a % b;
const exponentiate = (a, b) => a ** b;
const bitAnd = (a, b) => a & b;
const bitOr = (a, b) => a | b;
const bitXor = (a, b) => a ^ b;
const shiftLeft = (a, b) => a << b;
const shiftRight = (a, b) => a >> b;
const shiftRightUnsigned = (a, b) => a >>> b;
const lessThan = (a, b) => a < b;
const lessEqual = (a, b) => a <= b;
const greaterThan = (a, b) => a > b;
const greaterEqual = (a, b) => a >= b;
const equal = (a, b) => a == b;
const notEqual = (a, b) => a != b;
const strictEqual = (a, b) => a === b;
const strictNotEqual = (a, b) => a !== b;
const inOperator = (a, b) => a in b;
const instanceOf = (a, b) => a instanceof b;

const operations = [
	["+", add],
	["-", subtract],
	["*", multiply],
	["/", divide],
	["%", remainder],
	["**", exponentiate],
	["&", bitAnd],
	["|", bitOr],
	["^", bitXor],
	["<<", shiftLeft],
	[">>", shiftRight],
	[">>>", shiftRightUnsigned],
	["<", lessThan],
	["<=", lessEqual],
	[">", greaterThan],
	[">=", greaterEqual],
	["==", equal],
	["!=", notEqual],
	["===", strictEqual],
	["!==", strictNotEqual],
];

const values = [0, -0, 7, -3, 1.5, -2.25, 2147483648, NaN, Infinity, -Infinity];
const numeric = [];
for (const [name, operation] of operations) {
	for (const left of values) {
		for (const right of values) {
			numeric.push(
				name + ":" + repr(left) + ":" + repr(right) + "=" + repr(operation(left, right)),
			);
		}
	}
}

function capture(operation, marker) {
	try {
		return repr(operation());
	} catch (error) {
		return error === marker ? "throw:marker" : "throw:" + error.name;
	}
}

const fallback = [
	repr(add("x", 3)),
	repr(add(3, "x")),
	repr(lessThan("2", "10")),
	repr(lessThan("2", 3)),
	repr(equal("2", 2)),
	repr(strictEqual("2", 2)),
	repr(add(5n, 2n)),
	repr(subtract(5n, 2n)),
	repr(multiply(5n, 2n)),
	repr(divide(5n, 2n)),
	repr(remainder(5n, 2n)),
	repr(exponentiate(5n, 2n)),
	repr(bitAnd(5n, 3n)),
	repr(bitOr(5n, 2n)),
	repr(bitXor(5n, 3n)),
	repr(shiftLeft(5n, 2n)),
	repr(shiftRight(20n, 2n)),
	repr(lessThan(2n, 3)),
	repr(equal(2n, 2)),
	capture(() => add(1n, 1)),
	capture(() => shiftRightUnsigned(1n, 1n)),
	capture(() => subtract(Symbol("numeric"), 1)),
	capture(() => inOperator(1, 2)),
	capture(() => instanceOf(1, 2)),
];

const coercions = [];
function objectValue(label, value) {
	return {
		valueOf() {
			coercions.push(label);
			return value;
		},
	};
}

fallback.push(
	repr(add(objectValue("add", 2.5), 4)),
	repr(subtract(objectValue("sub", 6.5), 2)),
	repr(bitXor(objectValue("bit", 7), 3)),
	repr(lessThan(objectValue("rel", 2), 3)),
	repr(equal(objectValue("eq", 2), 2)),
	repr(add(objectValue("string", "object"), "-value")),
);

const marker = {};
const throwingLeft = {
	valueOf() {
		coercions.push("throw-left");
		throw marker;
	},
};
const skippedRight = {
	valueOf() {
		coercions.push("throw-right");
		return 1;
	},
};
fallback.push(capture(() => subtract(throwingLeft, skippedRight), marker));

const int32AddEdges = [
	add(2147483647, 1),
	add(-2147483648, -1),
	add(2147483647, -2147483648),
	add(-1, 1),
].map(repr);
const int32SubtractEdges = [
	subtract(2147483647, -1),
	subtract(-2147483648, 1),
	subtract(-2147483648, 2147483647),
	subtract(0, 0),
].map(repr);
const int32MultiplyEdges = [
	multiply(0, -3),
	multiply(-3, 0),
	multiply(-2147483648, -1),
	multiply(46341, 46341),
	multiply(2147483647, 2147483647),
].map(repr);
const int32ComparisonEdges = [
	lessThan(-2147483648, 2147483647),
	lessEqual(2147483647, 2147483647),
	greaterThan(2147483647, -2147483648),
	greaterEqual(-2147483648, -2147483648),
	equal(-2147483648, -2147483648),
	notEqual(-2147483648, 2147483647),
	strictEqual(2147483647, 2147483647),
	strictNotEqual(2147483647, -2147483648),
].map(repr);

console.log(
	JSON.stringify({
		numeric,
		fallback,
		coercions,
		int32AddEdges,
		int32SubtractEdges,
		int32MultiplyEdges,
		int32ComparisonEdges,
	}),
);
