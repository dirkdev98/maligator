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

function guardedSquare(value) {
	if (typeof value !== "number") return "not-number";
	return repr(value * value);
}

let guardedCoercions = 0;
const guardedObject = {
	valueOf() {
		guardedCoercions++;
		return 4;
	},
};
const guardedTypeFacts = [
	guardedSquare(3),
	guardedSquare(-0),
	guardedSquare(Number.NaN),
	guardedSquare("3"),
	guardedSquare(3n),
	guardedSquare(Symbol("3")),
	guardedSquare(guardedObject),
	String(guardedCoercions),
];

const membershipEvents = [];
const cleanHoley = [];
cleanHoley.length = 4;
cleanHoley[0] = undefined;
cleanHoley[2] = 2;
const changedHoley = [0, 1, 2];
delete changedHoley[1];
changedHoley.length = 1;
changedHoley.length = 3;
const accessorArray = [];
Object.defineProperty(accessorArray, "1", {
	configurable: true,
	get() {
		membershipEvents.push("own-getter");
		return 1;
	},
});
const customPrototypeArray = [];
customPrototypeArray.length = 2;
Object.setPrototypeOf(customPrototypeArray, { 1: 1 });
const proxyPrototypeArray = [];
proxyPrototypeArray.length = 2;
Object.setPrototypeOf(
	proxyPrototypeArray,
	new Proxy(
		{},
		{
			has(_target, key) {
				membershipEvents.push("prototype-has:" + String(key));
				return key === "1";
			},
		},
	),
);
const directProxy = new Proxy([], {
	has(_target, key) {
		membershipEvents.push("receiver-has:" + String(key));
		return key === "3";
	},
});
const unusualKeys = [1];
unusualKeys["0.5"] = true;
unusualKeys["-1"] = true;
unusualKeys["4294967295"] = true;
let coercionsIn = 0;
const coerciveKey = {
	toString() {
		coercionsIn++;
		return "0.5";
	},
};
const membershipMarker = {};
const throwingKey = {
	toString() {
		throw membershipMarker;
	},
};
const arrayMembership = [
	inOperator(0, cleanHoley),
	inOperator(1, cleanHoley),
	inOperator(2, cleanHoley),
	inOperator(3, cleanHoley),
	inOperator(-0, cleanHoley),
	inOperator(1, changedHoley),
	inOperator(2, changedHoley),
	inOperator(0, Object.freeze([undefined])),
	inOperator(1, accessorArray),
	membershipEvents.length,
	inOperator(1, customPrototypeArray),
	inOperator(1, proxyPrototypeArray),
	inOperator(3, directProxy),
	inOperator("-0", unusualKeys),
	inOperator(0.5, unusualKeys),
	inOperator(-1, unusualKeys),
	inOperator(4294967295, unusualKeys),
	inOperator(coerciveKey, unusualKeys),
	coercionsIn,
	capture(() => inOperator(throwingKey, unusualKeys), membershipMarker),
];
Object.defineProperty(Array.prototype, "1", {
	configurable: true,
	get() {
		membershipEvents.push("inherited-getter");
		return 1;
	},
});
const inheritedHoley = [];
inheritedHoley.length = 2;
arrayMembership.push(inOperator(1, inheritedHoley), membershipEvents.length);
delete Array.prototype[1];

console.log(
	JSON.stringify({
		numeric,
		fallback,
		coercions,
		int32AddEdges,
		int32SubtractEdges,
		int32MultiplyEdges,
		int32ComparisonEdges,
		guardedTypeFacts,
		arrayMembership,
		membershipEvents,
	}),
);
