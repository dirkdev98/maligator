const events = [];

function traced(label, value) {
	return {
		valueOf() {
			events.push(label);
			return value;
		},
	};
}

function hashElements(values) {
	let hash = 7;
	for (let index = 0; index < values.length; index++) hash = (hash + values[index]) | 0;
	return hash;
}

function mixElements(values) {
	let hash = 0;
	for (let index = 0; index < values.length; index++)
		hash = (values[index] - hash) ^ 0x5bd1e995;
	return hash;
}

function shiftTrunc(value, count) {
	return (Math.trunc(value) + count) << 3;
}

function powerPlusOne(x, y) {
	return (Math.pow(x, y) + 1) | 0;
}

function productOr(x, y, mask) {
	return (Math.imul(x, y) + 1) | mask;
}

globalThis.hashElements = hashElements;
globalThis.mixElements = mixElements;
globalThis.shiftTrunc = shiftTrunc;
globalThis.powerPlusOne = powerPlusOne;
globalThis.productOr = productOr;

const integers = Array.from({ length: 4096 }, (_, index) => (index * 2_654_435_761) | 0);
const wrapping = [2_147_483_647, 1, -2_147_483_648, -1, 2_147_483_647, 2_147_483_647];
const numbers = [
	1.5,
	-0,
	2 ** 40 + 3,
	-(2 ** 52),
	0.25,
	3,
	NaN,
	Infinity,
	-Infinity,
	2 ** 31,
];
const coercive = ["12", true, null, undefined, "x", [], [4], { valueOf: () => 9 }];
const traces = [traced("first", 3), traced("second", 2.5), traced("third", -4)];

const outputs = [];
for (const values of [integers, wrapping, numbers, coercive, traces, []]) {
	outputs.push(hashElements(values), mixElements(values));
}
for (const [value, count] of [
	[3, 4],
	[2.75, 1],
	[-2.5, 2],
	[2 ** 33 + 0.5, 1],
	[NaN, 5],
	[Infinity, 1],
	["7.9", "2"],
]) {
	outputs.push(shiftTrunc(value, count));
}
for (const [x, y] of [
	[2, 10],
	[2, 31],
	[2, 32],
	[3, 0.5],
	[-8, 1 / 3],
	["2", "3"],
]) {
	outputs.push(powerPlusOne(x, y));
}
for (const [x, y, mask] of [
	[65_537, 65_537, 0],
	[3, 7, 16],
	[-1, 1, 1.75],
	[5, 5, "8"],
	[5, 5, null],
	[5, 5, traced("mask", 32)],
	[2.9, 2 ** 33 + 5, 0],
	[-(2 ** 31), -1, 0],
	[NaN, 3, 0],
	[2 ** 53, 3.5, 0],
]) {
	outputs.push(productOr(x, y, mask));
}
console.log(JSON.stringify({ outputs, events }));
