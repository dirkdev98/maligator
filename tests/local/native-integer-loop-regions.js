function check(condition, message) {
	if (!condition) throw new Error(`FAIL ${message}`);
}

function collatzSteps(start) {
	let steps = 0;
	let value = start;
	while (value > 1) {
		value = (value & 1) === 0 ? value / 2 : value * 3 + 1;
		steps++;
	}
	return steps;
}

function hashRange(count) {
	let hash = 5381;
	for (let index = 0; index < count; index++)
		hash = ((hash << 5) ^ (hash >>> 3) ^ (index * 2654435761)) | 0;
	return hash;
}

function smallestFactor(value) {
	for (let divisor = 2; divisor * divisor <= value; divisor++)
		if (value % divisor === 0) return divisor;
	return value;
}

// Grows past 2^53, where double rounding must take over from the integer path.
function grows(seed) {
	let value = seed;
	let steps = 0;
	while (steps < 60) {
		value = value * 3 + (value % 2);
		steps++;
	}
	return value;
}

function negativeZero(start, rounds) {
	let value = start;
	let round = 0;
	while (round < rounds) {
		value = -(value % 7);
		round++;
	}
	return value;
}

function inexact(start) {
	let value = start;
	let steps = 0;
	while (value > 1 && steps < 40) {
		value = value / 3;
		steps++;
	}
	return value;
}

function remainderByZero(start) {
	let divisor = 3;
	let value = start;
	let steps = 0;
	while (steps < 5) {
		value = value % divisor;
		divisor--;
		steps++;
	}
	return value;
}

function parityRun(limit) {
	let even = true;
	let flips = 0;
	for (let index = 0; index < limit; index++) {
		if ((index & 3) === 0) even = !even;
		if (even) flips++;
	}
	return flips;
}

function bitsUpTo(limit) {
	let sum = 0;
	for (let index = 0; index < limit; index++) sum = (sum + (index & 7)) | 0;
	return sum;
}

function reference(name, values) {
	const expected = {
		collatz: [0, 111, 7, 350],
		hash: [5381, -1762832511, 1843038565],
		factor: [97, 3, 7919, 2],
	};
	return JSON.stringify(values) === JSON.stringify(expected[name]);
}

check(reference("collatz", [1, 27, 3, 77031].map(collatzSteps)), "collatz");
check(reference("hash", [0, 1000, 77777].map(hashRange)), "hash");
check(
	reference("factor", [97, 2187, 7919 * 7919, 1 << 20].map(smallestFactor)),
	"factor",
);
check(grows(7) === 3.1086849401825236e29, "growth matches double rounding");
check(Object.is(negativeZero(7, 1), -0), "negated zero");
check(Object.is(negativeZero(7, 2), 0), "negated negative zero");
check(Object.is(negativeZero(14, 3), -0), "third negation");
check(Object.is(negativeZero(-21, 1), 0), "negative remainder zero");
check(negativeZero(9, 1) === -2, "plain negation");
check(inexact(81) === 1, "exact division");
check(inexact(10) === 0.3703703703703704, "inexact division");
check(Number.isNaN(remainderByZero(17)), "remainder by zero");
check(negativeZero(7.5, 1) === -0.5, "fractional input");
check(
	Object.is(negativeZero(-0, 1), 0) && Object.is(negativeZero(-0, 2), -0),
	"negative zero input",
);
check(parityRun(1000) === 500, "Boolean loop state");
check(bitsUpTo(100) === 342, "small sum");
check(bitsUpTo("100") === 342, "string bound");
check(collatzSteps(2 ** 60) === 60, "power of two above the safe range");

let total = 0;
for (let start = 1; start < 3_000; start++)
	total = (total + collatzSteps(start)) % 1_000_007;
check(total === 215015, "collatz sum");

console.log("native-integer-loop-regions PASS");
