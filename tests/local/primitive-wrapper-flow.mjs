const events = [],
	results = [],
	sentinel = {};
function assert(value) {
	if (!value) throw new Error("wrapper flow invariant");
}

function booleanBranch(x, y, condition) {
	const value = condition ? new Boolean(x) : new Boolean(y);
	return value.valueOf();
}

function booleanLoop(x, y, condition) {
	let value = new Boolean(x);
	for (let i = 0; i < condition; i++) value = new Boolean(y);
	return value.valueOf();
}

function booleanTextLoop(x, y, condition) {
	let value = new Boolean(x);
	for (let i = 0; i < condition; i++) value = new Boolean(y);
	return value.toString();
}

function booleanTruthiness(x, y, condition) {
	const value = condition ? new Boolean(x) : new Boolean(y);
	return value ? 1 : 0;
}

function numberBranch(x, y, condition) {
	const value = condition ? new Number(x) : new Number(y);
	return value.valueOf();
}

function numberLoop(x, y, condition) {
	let value = new Number(x);
	for (let i = 0; i < condition; i++) value = new Number(y);
	return value.valueOf();
}

function numberTextLoop(x, y, condition) {
	let value = new Number(x);
	for (let i = 0; i < condition; i++) value = new Number(y);
	return value.toString();
}

function numberTruthiness(x, y, condition) {
	const value = condition ? new Number(x) : new Number(y);
	return value ? 1 : 0;
}

function stringBranch(x, y, condition) {
	const value = condition ? new String(x) : new String(y);
	return value.valueOf();
}

function stringLoop(x, y, condition) {
	let value = new String(x);
	for (let i = 0; i < condition; i++) value = new String(y);
	return value.valueOf();
}

function stringTextLoop(x, y, condition) {
	let value = new String(x);
	for (let i = 0; i < condition; i++) value = new String(y);
	return value.toString();
}

function stringTruthiness(x, y, condition) {
	const value = condition ? new String(x) : new String(y);
	return value ? 1 : 0;
}

function bigintBranch(x, y, condition) {
	const value = condition ? Object(BigInt(x)) : Object(BigInt(y));
	return value.valueOf();
}

function bigintLoop(x, y, condition) {
	let value = Object(BigInt(x));
	for (let i = 0; i < condition; i++) value = Object(BigInt(y));
	return value.valueOf();
}

function bigintTextLoop(x, y, condition) {
	let value = Object(BigInt(x));
	for (let i = 0; i < condition; i++) value = Object(BigInt(y));
	return value.toString();
}

function bigintTruthiness(x, y, condition) {
	const value = condition ? Object(BigInt(x)) : Object(BigInt(y));
	return value ? 1 : 0;
}

function symbolBranch(x, y, condition) {
	const value = condition ? Object(Symbol.for(x)) : Object(Symbol.for(y));
	return value.valueOf();
}

function symbolLoop(x, y, condition) {
	let value = Object(Symbol.for(x));
	for (let i = 0; i < condition; i++) value = Object(Symbol.for(y));
	return value.valueOf();
}

function symbolTextLoop(x, y, condition) {
	let value = Object(Symbol.for(x));
	for (let i = 0; i < condition; i++) value = Object(Symbol.for(y));
	return value.toString();
}

function symbolTruthiness(x, y, condition) {
	const value = condition ? Object(Symbol.for(x)) : Object(Symbol.for(y));
	return value ? 1 : 0;
}

globalThis.flowMethods = [
	booleanBranch,
	booleanLoop,
	booleanTextLoop,
	booleanTruthiness,
	numberBranch,
	numberLoop,
	numberTextLoop,
	numberTruthiness,
	stringBranch,
	stringLoop,
	stringTextLoop,
	stringTruthiness,
	bigintBranch,
	bigintLoop,
	bigintTextLoop,
	bigintTruthiness,
	symbolBranch,
	symbolLoop,
	symbolTextLoop,
	symbolTruthiness,
];

const coercible = {
	[Symbol.toPrimitive](hint) {
		events.push(hint);
		return "17";
	},
};
const throwing = {
	[Symbol.toPrimitive](hint) {
		events.push("throw:" + hint);
		throw sentinel;
	},
};
function encode(value) {
	if (typeof value === "symbol") return "symbol:" + Symbol.keyFor(value);
	if (typeof value === "number" && Object.is(value, -0)) return "number:-0";
	return typeof value + ":" + String(value);
}
for (const method of globalThis.flowMethods) {
	for (const pair of [
		[0, -0],
		[false, true],
		["", "17"],
		[NaN, Infinity],
		[17n, 18n],
		[coercible, "18"],
		["17", coercible],
		[Symbol.iterator, false],
		["17", throwing],
	]) {
		for (const count of [0, 1, 3]) {
			try {
				results.push(encode(method(pair[0], pair[1], count)));
			} catch (error) {
				results.push(error === sentinel ? "sentinel" : error.name);
			}
		}
	}
}
function toggle(x, count) {
	let value = new Boolean(x);
	for (let i = 0; i < count; i++) value = new Boolean(!value.valueOf());
	return value ? value.valueOf() : 99;
}
globalThis.toggle = toggle;
for (const count of [0, 1, 2, 3, 8]) {
	assert(globalThis.toggle(false, count) === (count % 2 === 1));
	assert(globalThis.toggle(true, count) === (count % 2 === 0));
}
function escape(x, y, condition) {
	return condition ? new Boolean(x) : new Boolean(y);
}
globalThis.escapeWrapper = escape;
const first = globalThis.escapeWrapper(false, true, true),
	second = globalThis.escapeWrapper(false, true, true);
assert(first !== second && first.valueOf() === false && second.valueOf() === false);
assert(Object.getPrototypeOf(first) === Boolean.prototype);
function mixed(x, condition) {
	const value = condition ? new Boolean(x) : false;
	return value.valueOf();
}
globalThis.mixed = mixed;
assert(globalThis.mixed(true, false) === false && globalThis.mixed(true, true) === true);
const changed = globalThis.escapeWrapper(false, true, true);
assert(
	changed.valueOf(
		Object.defineProperty(changed, "valueOf", {
			value() {
				return sentinel;
			},
		}),
	) === false,
);
assert(changed.valueOf() === sentinel);
const proxy = new Proxy(first, {
	get(target, key, receiver) {
		assert(key === "valueOf" && receiver === proxy);
		return function () {
			assert(this === proxy);
			return sentinel;
		};
	},
});
function unproved(x, condition) {
	const value = condition ? new Boolean(false) : x;
	return value.valueOf();
}
globalThis.unproved = unproved;
assert(
	globalThis.unproved(proxy, false) === sentinel &&
		globalThis.unproved(proxy, true) === false,
);
function NewTarget() {}
NewTarget.prototype = {
	valueOf() {
		return sentinel;
	},
};
const alternate = Reflect.construct(Boolean, [false], NewTarget);
assert(globalThis.unproved(alternate, false) === sentinel);
function exceptional(x, condition) {
	let value = new Boolean(x);
	try {
		if (condition) throw sentinel;
		value = new Boolean(!x);
	} catch (error) {
		assert(error === sentinel);
		results.push("caught:" + value.valueOf());
		globalThis.observed = value;
	}
	return value.valueOf();
}
globalThis.exceptional = exceptional;
assert(
	globalThis.exceptional(false, true) === false &&
		globalThis.observed.valueOf() === false,
);
assert(globalThis.exceptional(false, false) === true);
if (!Object.isFrozen(Boolean.prototype)) {
	const original = Boolean.prototype.valueOf;
	try {
		Boolean.prototype.valueOf = function () {
			return sentinel;
		};
		assert(globalThis.flowMethods[1](false, true, 3) === sentinel);
	} finally {
		Boolean.prototype.valueOf = original;
	}
}
function stringConsumer0(x, y, condition) {
	let value = new String(x);
	for (let i = 0; i < condition; i++) value = new String(y);
	return value.charAt(0);
}
function stringConsumer1(x, y, condition) {
	let value = new String(x);
	for (let i = 0; i < condition; i++) value = new String(y);
	return value.indexOf("a");
}
function stringConsumer2(x, y, condition) {
	let value = new String(x);
	for (let i = 0; i < condition; i++) value = new String(y);
	return value.startsWith("a");
}
function stringConsumer3(x, y, condition) {
	let value = new String(x);
	for (let i = 0; i < condition; i++) value = new String(y);
	return value.slice(1);
}
function stringConsumer4(x, y, condition) {
	let value = new String(x);
	for (let i = 0; i < condition; i++) value = new String(y);
	return value.repeat(2);
}
function stringConsumer5(x, y, condition) {
	let value = new String(x);
	for (let i = 0; i < condition; i++) value = new String(y);
	return value.padEnd(8, ".");
}
function stringConsumer6(x, y, condition) {
	let value = new String(x);
	for (let i = 0; i < condition; i++) value = new String(y);
	return value.trim();
}
function stringConsumer7(x, y, condition) {
	let value = new String(x);
	for (let i = 0; i < condition; i++) value = new String(y);
	return value.split(",");
}
function stringConsumer8(x, y, condition) {
	let value = new String(x);
	for (let i = 0; i < condition; i++) value = new String(y);
	return value.replace("a", "b");
}
function numberFormat0(x, y, condition) {
	let value = new Number(x);
	for (let i = 0; i < condition; i++) value = new Number(y);
	return value.toFixed(2);
}
function numberFormat1(x, y, condition) {
	let value = new Number(x);
	for (let i = 0; i < condition; i++) value = new Number(y);
	return value.toExponential(3);
}
function numberFormat2(x, y, condition) {
	let value = new Number(x);
	for (let i = 0; i < condition; i++) value = new Number(y);
	return value.toPrecision(4);
}
function numberFormat3(x, y, condition) {
	let value = new Number(x);
	for (let i = 0; i < condition; i++) value = new Number(y);
	return value.toString(16);
}
function symbolDescription(x, y, condition) {
	let value = Object(Symbol.for(x));
	for (let i = 0; i < condition; i++) value = Object(Symbol.for(y));
	return value.description;
}
globalThis.dataConsumers = [
	stringConsumer0,
	stringConsumer1,
	stringConsumer2,
	stringConsumer3,
	stringConsumer4,
	stringConsumer5,
	stringConsumer6,
	stringConsumer7,
	stringConsumer8,
	numberFormat0,
	numberFormat1,
	numberFormat2,
	numberFormat3,
	symbolDescription,
];
for (const method of globalThis.dataConsumers) {
	for (const pair of [
		[" a,b ", "abc"],
		[0, -0],
		["17", coercible],
		[coercible, "18"],
		[Symbol.iterator, "17"],
		["17", throwing],
	]) {
		for (const count of [0, 1, 3]) {
			try {
				results.push(encode(method(pair[0], pair[1], count)));
			} catch (error) {
				results.push(error === sentinel ? "sentinel" : error.name);
			}
		}
	}
}
function protocolMatch(x, pattern, count) {
	let value = new String(x);
	for (let i = 0; i < count; i++) value = new String(x);
	return value.match(pattern, "!");
}
function protocolMatchAll(x, pattern, count) {
	let value = new String(x);
	for (let i = 0; i < count; i++) value = new String(x);
	return value.matchAll(pattern, "!");
}
function protocolSearch(x, pattern, count) {
	let value = new String(x);
	for (let i = 0; i < count; i++) value = new String(x);
	return value.search(pattern, "!");
}
function protocolSplit(x, pattern, count) {
	let value = new String(x);
	for (let i = 0; i < count; i++) value = new String(x);
	return value.split(pattern, "!");
}
function protocolReplace(x, pattern, count) {
	let value = new String(x);
	for (let i = 0; i < count; i++) value = new String(x);
	return value.replace(pattern, "!");
}
function protocolReplaceAll(x, pattern, count) {
	let value = new String(x);
	for (let i = 0; i < count; i++) value = new String(x);
	return value.replaceAll(pattern, "!");
}
globalThis.protocolConsumers = [
	protocolMatch,
	protocolMatchAll,
	protocolSearch,
	protocolSplit,
	protocolReplace,
	protocolReplaceAll,
];
const protocolKeys = [
	Symbol.match,
	Symbol.matchAll,
	Symbol.search,
	Symbol.split,
	Symbol.replace,
	Symbol.replace,
];
for (let i = 0; i < globalThis.protocolConsumers.length; i++) {
	const key = protocolKeys[i];
	const pattern = { [Symbol.match]: false };
	pattern[key] = function (value) {
		return value;
	};
	const result = globalThis.protocolConsumers[i]("abc", pattern, 3);
	assert(
		typeof result === "object" &&
			Object.getPrototypeOf(result) === String.prototype &&
			result.valueOf() === "abc",
	);
}
function readNumberMethod(x, count) {
	let value = new Number(x);
	for (let i = 0; i < count; i++) value = new Number(x);
	return value.toFixed;
}
globalThis.readNumberMethod = readNumberMethod;
const beforeMethodRead = events.length;
assert(globalThis.readNumberMethod(coercible, 3) === Number.prototype.toFixed);
assert(events.length === beforeMethodRead + 4);

console.log(JSON.stringify({ results, events }));
