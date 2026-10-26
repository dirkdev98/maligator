function imul(x, y) {
	return Math.imul(x, y);
}
function clz32(x) {
	return Math.clz32(x);
}
function f16round(x) {
	return Math.f16round(x);
}
function pow(x, y) {
	return Math.pow(x, y);
}
function atan2(x, y) {
	return Math.atan2(x, y);
}
function missingImul(x) {
	return Math.imul(x);
}
function extraImul(x, y) {
	return Math.imul(x, y, ++effects);
}
Object.assign(globalThis, { imul, clz32, f16round, pow, atan2, missingImul, extraImul });
const results = [];
function record(value) {
	results.push(Object.is(value, -0) ? "-0" : String(value));
}
for (const value of [NaN, Infinity, -Infinity, -0, 0, 1, -1, 1.5, -1.5, 4294967297]) {
	record(globalThis.imul(value, 5));
	record(globalThis.clz32(value));
	record(globalThis.f16round(value));
	record(globalThis.pow(value, 2));
	record(globalThis.atan2(value, Infinity));
}
record(globalThis.missingImul(7));
for (const value of [undefined, null, true, false, "3.5", "invalid"]) {
	record(globalThis.imul(value, "2"));
	record(globalThis.clz32(value));
	record(globalThis.f16round(value));
	record(globalThis.pow(value, "2"));
	record(globalThis.atan2(value, Infinity));
}
const order = [];
const left = {
	valueOf() {
		order.push("left");
		return 4294967297;
	},
};
const right = {
	valueOf() {
		order.push("right");
		return -3;
	},
};
record(globalThis.imul(left, right));
record(order.join(","));
order.length = 0;
const marker = {};
const throwing = {
	valueOf() {
		order.push("throw");
		throw marker;
	},
};
try {
	globalThis.imul(throwing, right);
} catch (error) {
	record(error === marker);
}
record(order.join(","));
for (const operation of [
	globalThis.imul,
	globalThis.clz32,
	globalThis.f16round,
	globalThis.pow,
	globalThis.atan2,
]) {
	for (const value of [1n, Symbol()]) {
		try {
			operation(value, 2);
			record("missing error");
		} catch (error) {
			record(error instanceof TypeError);
		}
	}
}
let effects = 0;
record(globalThis.extraImul(3, 7));
record(effects);
record(globalThis.pow(-0, 3));
record(globalThis.pow(1, Infinity));
record(globalThis.atan2(-0, 0));

function recurrence(seed, iterations) {
	let value = seed;
	for (let index = 0; index < iterations; index++)
		value = (Math.imul(value, 1664525) + 1013904223) | 0;
	return value;
}
function integerPairs(x, y) {
	return [
		(Math.imul(x, y) + 2147483647) | 0,
		(Math.imul(x, y) - -2147483648) ^ Math.clz32(x),
		(Math.imul(x, y) + Math.clz32(y)) << 31,
		31 >> (Math.imul(x, y) - Math.clz32(y)),
		(Math.imul(x, y) - Math.clz32(y)) & -1,
	];
}
function escapingPair(x, y) {
	const sum = Math.imul(x, y) + 2147483647;
	return [sum, sum | 0];
}
function fractionalPair(x, y) {
	return [(Math.pow(x, y) + 1.75) | 0, (x * y) | 0];
}
function interveningCallPair(x, y) {
	return (Math.imul(x, y) + 2147483647) | Math.clz32(globalThis.allocate());
}
Object.assign(globalThis, {
	recurrence,
	integerPairs,
	escapingPair,
	fractionalPair,
	interveningCallPair,
	allocate() {
		const values = Array.from({ length: 32 }, (_, index) => ({ value: index }));
		return values.length;
	},
});
for (const seed of [left, throwing, marker, Symbol(), 1n, undefined, NaN, -0]) {
	record(Object.is(globalThis.recurrence(seed, 0), seed));
}
for (const value of [
	-2147483648,
	2147483647,
	4294967295,
	1.75,
	NaN,
	Infinity,
	-0,
	"7",
	left,
]) {
	record(globalThis.integerPairs(value, 3).join(","));
	record(globalThis.escapingPair(value, 3).join(","));
	record(globalThis.fractionalPair(value, 2).join(","));
	record(globalThis.recurrence(value, 1));
	record(globalThis.recurrence(value, 50));
	record(globalThis.interveningCallPair(value, 3));
}
record(globalThis.fractionalPair(4294967295, 4294967295).join(","));
for (const seed of [throwing, Symbol(), 1n]) {
	try {
		globalThis.recurrence(seed, 1);
		record("missing recurrence error");
	} catch (error) {
		record(error === marker || error instanceof TypeError);
	}
}

function integralRounding(input) {
	const value = input | 0;
	return [Math.floor(value), Math.ceil(value), Math.trunc(value), Math.round(value)].join(
		":",
	);
}
Object.assign(globalThis, { integralRounding });
for (const value of [
	-0,
	0,
	-1,
	-1.5,
	-10,
	2147483647,
	2147483648,
	4294967295,
	4294967296,
	NaN,
	Infinity,
	-Infinity,
])
	record(globalThis.integralRounding(value));
let roundingCoercions = 0;
record(
	globalThis.integralRounding({
		valueOf() {
			roundingCoercions++;
			return -17.8;
		},
	}),
);
record(roundingCoercions);
for (const value of [1n, Symbol("rounding")]) {
	try {
		globalThis.integralRounding(value);
		record("missing rounding error");
	} catch (error) {
		record(error instanceof TypeError);
	}
}
const roundedByte = function roundedByte(input, hook) {
	try {
		hook();
		return Math.round(input & 255);
	} catch (error) {
		throw error;
	}
};
function roundedByteRemainder(input, hook) {
	const value = roundedByte(input, hook);
	hook();
	return value % 10;
}
const roundedSigned = function roundedSigned(input, hook) {
	try {
		hook();
		return Math.trunc(input | 0);
	} catch (error) {
		throw error;
	}
};
function roundedSignedRemainder(input, hook) {
	const value = roundedSigned(input, hook);
	hook();
	return value % 10;
}
function roundedUnsigned(input, hook) {
	const value = Math.ceil(input >>> 0);
	hook();
	return value;
}
const roundedRecord = function roundedRecord(input, hook) {
	try {
		hook();
		return { value: Math.floor(input & 255) };
	} catch (error) {
		throw error;
	}
};
function* roundedFieldAcrossYield(input, hook) {
	const record = roundedRecord(input, hook);
	yield record.value;
	hook();
	return record.value % 10;
}
function roundingPulse() {
	if (typeof globalThis.gc === "function") globalThis.gc();
}
Object.assign(globalThis, {
	roundedByte,
	roundedByteRemainder,
	roundedUnsigned,
	roundedSigned,
	roundedSignedRemainder,
	roundedFieldAcrossYield,
});
for (const input of [
	-0,
	0,
	-10,
	NaN,
	Infinity,
	-Infinity,
	2147483647,
	2147483648,
	4294967295,
	4294967296,
	9007199254740991,
]) {
	record(globalThis.roundedByteRemainder(input, roundingPulse));
	record(globalThis.roundedUnsigned(input, roundingPulse));
	record(globalThis.roundedSignedRemainder(input, roundingPulse));
	const iterator = globalThis.roundedFieldAcrossYield(input, roundingPulse);
	record(iterator.next().value);
	roundingPulse();
	record(iterator.next().value);
}
for (const input of [1n, Symbol("rounded return")]) {
	try {
		globalThis.roundedByteRemainder(input, roundingPulse);
		record("missing rounded return error");
	} catch (error) {
		record(error instanceof TypeError);
	}
}
console.log(JSON.stringify(results));
