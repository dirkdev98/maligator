"use strict";
// Numeric loop regions whose iteration restarts in the loop's original code, which
// returns to the region once it has finished that iteration: holes, holes an inherited
// getter fills, getters that change the iterated array, elements that switch between
// Numbers and other values, fractions, overflow, early exits, nested loops, and loops
// whose every iteration restarts.
const results = [];
function show(value) {
	return Object.is(value, -0) ? "-0" : String(value);
}
function record(label, value) {
	results.push(`${label}=${show(value)}`);
}

function wrappedSum(values) {
	let total = 0;
	for (const value of values) total = (total + value) | 0;
	return total;
}
function plainSum(values) {
	let total = -0;
	for (const value of values) total += value;
	return total;
}
function indexedSum(values) {
	let total = 0;
	for (let index = 0; index < values.length; index++) total = (total + values[index]) | 0;
	return total;
}
function firstAbove(values, limit) {
	for (const value of values) if (value > limit) return value;
	return -1;
}
function rowSums(rows) {
	let total = 0;
	for (const row of rows) {
		let sum = 0;
		for (const value of row) sum = (sum + value) | 0;
		total = (total * 31 + sum) | 0;
	}
	return total;
}
function polynomial(rounds) {
	let value = 0;
	for (let index = 0; index < rounds; index++) value = value * 3 + index;
	return value;
}

const size = 64;
const ints = Array.from({ length: size }, (_, index) => index * 3 + 1);
const holeFirst = ints.slice();
delete holeFirst[0];
const holeMiddle = ints.slice();
delete holeMiddle[size >> 1];
const nullFirst = [null, ...ints.slice(1)];
const holeEvery8 = ints.slice();
for (let index = 3; index < size; index += 8) delete holeEvery8[index];
const fractions = ints.map((value, index) => (index % 16 === 5 ? value + 0.5 : value));
const switching = ints.map((value, index) =>
	index % 5 === 2
		? String(value)
		: index % 7 === 3
			? null
			: index % 11 === 6
				? true
				: value,
);
const large = ints.map((value, index) => (index === 9 ? 2 ** 40 : value));
let conversions = 0;
const convertible = ints.map((value, index) =>
	index % 13 === 4
		? {
				valueOf() {
					conversions++;
					return value;
				},
			}
		: value,
);
const strings = ints.map(String);

// Every caller reaches the loops through these, so each stays one site.
const runners = [wrappedSum, plainSum, indexedSum];
const rounds = 32;
let warm = 0;
for (let round = 0; round < rounds; round++)
	warm =
		(warm + runners[0](holeFirst) + runners[1](nullFirst) + runners[2](holeFirst)) | 0;
record("warm", warm);
record("restarting", 3 * rounds);
let failing = 0;
for (let round = 0; round < rounds; round++)
	failing = (failing + wrappedSum(strings)) | 0;
record("failing-sum", failing);
record("failing", rounds * size);

for (const [name, values] of [
	["ints", ints],
	["hole-middle", holeMiddle],
	["hole-every-8", holeEvery8],
	["fractions", fractions],
	["switching", switching],
	["large", large],
	["convertible", convertible],
])
	record(
		name,
		[
			wrappedSum(values),
			plainSum(values),
			indexedSum(values),
			firstAbove(values, 150),
			firstAbove(values, 1e6),
		].join(","),
	);
record("conversions", conversions);
record("rows", rowSums([ints, holeFirst, fractions, switching, [], holeEvery8, large]));
record("polynomial", `${polynomial(20)},${polynomial(40)},${polynomial(60)}`);

let getterReads = 0;
Object.defineProperty(Array.prototype, "0", {
	configurable: true,
	get() {
		getterReads++;
		return 500;
	},
});
record(
	"inherited",
	`${wrappedSum(holeFirst)},${plainSum(holeFirst)},${indexedSum(holeFirst)}`,
);
delete Array.prototype[0];

// The getter runs while the loop's original code finishes the hole's iteration, so the
// region that resumes after it sees the array as the getter left it.
function holeAt4() {
	const values = ints.slice();
	delete values[4];
	return values;
}
Object.defineProperty(Array.prototype, "4", {
	configurable: true,
	get() {
		getterReads++;
		this[10] = "x";
		this[11] = 0.25;
		delete this[12];
		this.push(7, 8);
		return 4;
	},
});
record(
	"reshaped",
	`${wrappedSum(holeAt4())},${plainSum(holeAt4())},${indexedSum(holeAt4())}`,
);
Object.defineProperty(Array.prototype, "4", {
	configurable: true,
	get() {
		getterReads++;
		this.length = 8;
		return 4;
	},
});
record(
	"truncated",
	`${wrappedSum(holeAt4())},${plainSum(holeAt4())},${indexedSum(holeAt4())}`,
);
delete Array.prototype[4];
record("getter-reads", getterReads);

console.log(results.join("\n"));
