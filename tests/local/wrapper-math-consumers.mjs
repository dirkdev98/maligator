function check(condition, message) {
	if (!condition) throw new Error(message);
}
function typeError(run) {
	let error;
	try {
		run();
	} catch (caught) {
		error = caught;
	}
	check(error instanceof TypeError, "expected TypeError");
}
const cases = [
	["abs", (value, other) => Math.abs(new Number(value), other)],
	["floor", (value, other) => Math.floor(new Number(value), other)],
	["ceil", (value, other) => Math.ceil(new Number(value), other)],
	["round", (value, other) => Math.round(new Number(value), other)],
	["trunc", (value, other) => Math.trunc(new Number(value), other)],
	["sqrt", (value, other) => Math.sqrt(new Number(value), other)],
	["cbrt", (value, other) => Math.cbrt(new Number(value), other)],
	["sign", (value, other) => Math.sign(new Number(value), other)],
	["log", (value, other) => Math.log(new Number(value), other)],
	["log2", (value, other) => Math.log2(new Number(value), other)],
	["log10", (value, other) => Math.log10(new Number(value), other)],
	["exp", (value, other) => Math.exp(new Number(value), other)],
	["sin", (value, other) => Math.sin(new Number(value), other)],
	["cos", (value, other) => Math.cos(new Number(value), other)],
	["tan", (value, other) => Math.tan(new Number(value), other)],
	["asin", (value, other) => Math.asin(new Number(value), other)],
	["acos", (value, other) => Math.acos(new Number(value), other)],
	["atan", (value, other) => Math.atan(new Number(value), other)],
	["sinh", (value, other) => Math.sinh(new Number(value), other)],
	["cosh", (value, other) => Math.cosh(new Number(value), other)],
	["tanh", (value, other) => Math.tanh(new Number(value), other)],
	["asinh", (value, other) => Math.asinh(new Number(value), other)],
	["acosh", (value, other) => Math.acosh(new Number(value), other)],
	["atanh", (value, other) => Math.atanh(new Number(value), other)],
	["log1p", (value, other) => Math.log1p(new Number(value), other)],
	["expm1", (value, other) => Math.expm1(new Number(value), other)],
	["fround", (value, other) => Math.fround(new Number(value), other)],
	["atan2", (value, other) => Math.atan2(new Number(value), other)],
	["pow", (value, other) => Math.pow(new Number(value), other)],
	["imul", (value, other) => Math.imul(new Number(value), other)],
	["clz32", (value, other) => Math.clz32(new Number(value), other)],
	["hypot", (value, other) => Math.hypot(new Number(value), other)],
	["min", (value, other) => Math.min(new Number(value), other)],
	["max", (value, other) => Math.max(new Number(value), other)],
	["f16round", (value, other) => Math.f16round(new Number(value), other)],
];
for (const [name, wrapped] of cases) {
	for (const value of [NaN, -Infinity, -256, -1, -0, 0, 0.25, 1, 2, 255, Infinity]) {
		for (const other of [-0, 2, NaN]) {
			const expected = Math[name](Number(value), other);
			check(Object.is(wrapped(value, other), expected), name + " wrapped result");
		}
	}
	typeError(() => wrapped(Symbol.iterator, 2));
}
function brands(value) {
	return [Math.abs(new Boolean(value)), Math.abs(new String(value))];
}
for (const value of [0, -0, -2, 3, NaN, Infinity]) {
	const result = brands(value);
	check(Object.is(result[0], Math.abs(Boolean(value))), "Boolean payload");
	check(Object.is(result[1], Math.abs(String(value))), "String payload");
}
function rejectedBigint(value) {
	return Math.abs(Object(BigInt(value)));
}
function rejectedSymbol(value) {
	return Math.abs(Object(Symbol(value)));
}
typeError(() => rejectedBigint(2));
typeError(() => rejectedSymbol("x"));
function laterInputs(value) {
	return [
		Math.atan2(3, new Number(value)),
		Math.pow(3, new Number(value)),
		Math.imul(3, new Number(value)),
		Math.min(3, new Number(value), 7),
		Math.max(3, new Number(value), 7),
		Math.hypot(3, 4, new Number(value)),
	];
}
for (const value of [-0, 2, NaN, Infinity]) {
	const expected = [
		Math.atan2(3, value),
		Math.pow(3, value),
		Math.imul(3, value),
		Math.min(3, value, 7),
		Math.max(3, value, 7),
		Math.hypot(3, 4, value),
	];
	const actual = laterInputs(value);
	check(
		actual.every((item, index) => Object.is(item, expected[index])),
		"later input positions",
	);
}
const events = [];
const marker = {};
function input() {
	events.push("input");
	return {
		[Symbol.toPrimitive](hint) {
			events.push("input:" + hint);
			return -2;
		},
	};
}
function other() {
	events.push("other");
	return {
		[Symbol.toPrimitive](hint) {
			events.push("other:" + hint);
			return 3;
		},
	};
}
function order() {
	return Math.pow(new Number(input()), other());
}
check(order() === -8, "ordered pow result");
check(
	events.join() === "input,input:number,other,other:number",
	"constructor conversion before next argument",
);
events.length = 0;
function ignored() {
	return Math.abs(new Number(input()), other());
}
check(ignored() === 2, "ignored extra value");
check(
	events.join() === "input,input:number,other",
	"ignored extra expression without coercion",
);
function poison() {
	events.push("poison");
	throw marker;
}
function minPoison() {
	return Math.min(new Number(NaN), { valueOf: poison });
}
function maxPoison() {
	return Math.max(new Number(NaN), { valueOf: poison });
}
function hypotPoison() {
	return Math.hypot(new Number(Infinity), { valueOf: poison });
}
for (const run of [minPoison, maxPoison, hypotPoison]) {
	events.length = 0;
	let caught;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	check(
		caught === marker && events.join() === "poison",
		"later coercion survives nonfinite first input",
	);
}
function failureOrder() {
	return Math.pow(new Number(Symbol.iterator), poison());
}
events.length = 0;
typeError(failureOrder);
check(events.length === 0, "constructor failure precedes later expression");
function escaped(value) {
	const wrapper = new Number(value);
	globalThis.mathWrapper = wrapper;
	const result = Math.abs(wrapper);
	return [wrapper, result];
}
const first = escaped(-2),
	second = escaped(-2);
check(
	first[0] !== second[0] && first[0] instanceof Number && first[1] === 2,
	"escaped wrapper identity",
);
function ownOverride(value) {
	const wrapper = new Number(value);
	wrapper[Symbol.toPrimitive] = () => -9;
	return Math.abs(wrapper);
}
check(ownOverride(2) === 9, "own coercion override");
function exposedMutation(value) {
	const wrapper = new Number(value);
	function mutate() {
		wrapper[Symbol.toPrimitive] = () => 7;
		return 3;
	}
	return Math.min(wrapper, mutate());
}
check(exposedMutation(2) === 3, "later argument mutates exposed wrapper");
class Derived extends Number {
	valueOf() {
		return -12;
	}
}
check(Math.abs(new Derived(2)) === 12, "subclass coercion");
if (!Object.isFrozen(Number.prototype)) {
	const original = Number.prototype.valueOf;
	try {
		Number.prototype.valueOf = function () {
			return -14;
		};
		check(cases[0][1](2) === 14, "mutable wrapper prototype");
	} finally {
		Number.prototype.valueOf = original;
	}
	const abs = Math.abs;
	try {
		Math.abs = (value) => (value instanceof Number ? 17 : 18);
		check(cases[0][1](2) === 17, "mutable Math receives object identity");
	} finally {
		Math.abs = abs;
	}
}
console.log("wrapper Math consumers passed");
