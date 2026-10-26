function check(condition, message) {
	if (!condition) throw new Error(`FAIL ${message}`);
}

function mixedStorage(callback) {
	let sum = 0.5;
	for (let index = 0; index < 16; index++) {
		callback(index);
		sum += index;
	}
	return sum;
}

function sharedStorage(callback) {
	let sum = 0;
	for (let index = 0; index < 16; index++) {
		callback(index);
		sum += index / 2;
	}
	for (let fraction = 0; fraction < 3.5; fraction += 0.5) {
		callback(fraction);
		sum += fraction;
	}
	return sum;
}

function moduloStorage(callback) {
	let sum = 0;
	for (let index = 0; index < 32; index++) {
		callback(index);
		sum += (index * 3 + 1) % 7;
	}
	return sum;
}

function boundaryStorage(start, bound, step, callback) {
	let index = start;
	for (; index < bound; index += step) callback(index);
	return index;
}

function negativeZeroStorage(callback) {
	let sum = -0;
	for (let index = 0; index < 4; index++) {
		callback(index);
		sum *= index;
	}
	return sum;
}

function caughtStorage(callback) {
	let sum = 0.5;
	for (let index = 0; index < 16; index++) {
		try {
			callback(index);
			sum += index;
		} catch (error) {
			return [index, sum, error];
		}
	}
	return sum;
}

function* suspendedStorage(callback) {
	let sum = 0.5;
	for (let index = 0; index < 4; index++) {
		yield index;
		callback(index);
		sum += index;
	}
	return sum;
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

// A fused chain over a boxed count, through overflow past the safe range.
function fusedSteps(limit, step, scale) {
	let count = 0;
	for (let index = 0; index < limit; index += step) count = (count * scale + 1) | 0;
	return count;
}

// Bindings of the script and of an enclosing function, loaded once per entry.
function scaledSum(limit) {
	let sum = 0;
	for (let index = 0; index < limit; index++) sum = (sum + index * SCALE) | 0;
	return sum;
}

function makeScaler(factor) {
	function capturedSum(limit) {
		let sum = 0;
		for (let index = 0; index < limit; index++) sum = (sum + index * factor) | 0;
		return sum;
	}
	return capturedSum;
}

const beforeScale = [0, 3].map((limit) => {
	try {
		return scaledSum(limit);
	} catch (error) {
		return error.constructor.name;
	}
});
let SCALE = 3;

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

check(
	JSON.stringify([
		fusedSteps(1000, 1, 3),
		fusedSteps(1000, 3, 2 ** 30),
		fusedSteps(100, 0.5, -7),
		fusedSteps(10, 1, "3"),
		fusedSteps(10, 1, 2 ** 53),
	]) === "[-371446384,1073741825,2045412584,29524,0]",
	"fused steps",
);
let coercions = 0;
check(
	fusedSteps(
		5,
		{
			valueOf() {
				coercions++;
				return 2;
			},
		},
		2,
	) === 7 && coercions === 3,
	"fused step coercion on every fallback iteration",
);
try {
	fusedSteps(5, 1n, 2);
	check(false, "mixed BigInt step must throw");
} catch (error) {
	check(error instanceof TypeError, "mixed BigInt step type error");
}
check(
	JSON.stringify(beforeScale) === '[0,"ReferenceError"]',
	"scale before initialization",
);
const scaled = [];
for (const scale of [3, 0.5, -2, "2", 2 ** 40]) {
	SCALE = scale;
	scaled.push(scaledSum(100));
}
check(JSON.stringify(scaled) === "[14850,2450,-9900,9900,0]", "scaled sums");
check(
	JSON.stringify([7, 2.5, "3"].map((factor) => makeScaler(factor)(100))) ===
		"[34650,12350,14850]",
	"captured factors",
);

let total = 0;
for (let start = 1; start < 3_000; start++)
	total = (total + collatzSteps(start)) % 1_000_007;
check(total === 215015, "collatz sum");

const storageEvents = [];
function observeStorage(value) {
	storageEvents.push(value);
	if (typeof globalThis.gc === "function") globalThis.gc();
}
check(mixedStorage(observeStorage) === 120.5, "mixed scalar storage");
check(sharedStorage(observeStorage) === 70.5, "shared scalar constant");
check(moduloStorage(observeStorage) === 92, "integer modulo chain");
check(Object.is(negativeZeroStorage(observeStorage), -0), "floating negative zero");
check(
	boundaryStorage(2147483646, 2147483648, 1, observeStorage) === 2147483648,
	"final update outside int32",
);
check(
	boundaryStorage(-2147483649, -2147483647, 1, observeStorage) === -2147483647,
	"initial value outside int32",
);
check(boundaryStorage(0, 3.5, 0.5, observeStorage) === 3.5, "fractional update");
let boundCoercions = 0;
check(
	boundaryStorage(
		0,
		{
			valueOf() {
				boundCoercions++;
				return 3;
			},
		},
		1,
		observeStorage,
	) === 3 && boundCoercions === 4,
	"coercive loop bound",
);
const storageFailure = { marker: "storage failure" };
const caughtStorageResult = caughtStorage((value) => {
	observeStorage(value);
	if (value === 3) throw storageFailure;
});
check(
	caughtStorageResult[0] === 3 &&
		caughtStorageResult[1] === 3.5 &&
		caughtStorageResult[2] === storageFailure,
	"exceptional scalar observations",
);
const storageGenerator = suspendedStorage(observeStorage);
for (let index = 0; index < 4; index++) {
	const result = storageGenerator.next();
	check(result.value === index && !result.done, "suspended integer counter");
}
const storageFinal = storageGenerator.next();
check(storageFinal.done && storageFinal.value === 6.5, "suspended floating accumulator");
check(storageEvents.length === 97, "callback observations");

console.log("native-integer-loop-regions PASS");
