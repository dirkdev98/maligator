function check(condition) {
	if (!condition) throw new Error("rest iteration mismatch");
}

function sum(base, ...values) {
	let total = base;
	for (const value of values) total += value;
	return total;
}

function churn() {
	for (let index = 0; index < 80; index++) {
		const item = { values: [index, index + 1] };
		if (item.values[0] !== index) throw new Error("churn mismatch");
	}
	globalThis.gc?.();
}

function objects(...values) {
	let total = 0;
	for (const value of values) {
		churn();
		total += value.amount;
	}
	return total;
}

function stop(limit, ...values) {
	let total = 0;
	try {
		for (const value of values) {
			total += value;
			if (total > limit) break;
		}
	} finally {
		churn();
	}
	return total;
}

function repeated(rounds, ...values) {
	let total = 0;
	for (let round = 0; round < rounds; round++)
		for (const value of values) total += value + round;
	return total;
}

function escape(...values) {
	globalThis.savedRest = values;
	let total = 0;
	for (const value of values) {
		total += value;
		if (total === 1) globalThis.savedRest.push(5);
	}
	return total;
}

function write(...values) {
	let total = 0;
	for (const value of values) {
		total += value;
		values[1] = 7;
	}
	return total;
}

function returning(...values) {
	for (const value of values) {
		if (value > 2) return value;
	}
	return -1;
}

function forwardAndIterate(base, ...values) {
	let total = 0;
	for (const value of values) {
		churn();
		total += value;
	}
	return sum(...arguments) + total;
}

function delayedIteration(...values) {
	let total = 0;
	for (let index = 0; index < 128; index++) total += index;
	for (const value of values) total += value.amount;
	for (let index = 0; index < 128; index++) total += index;
	return total;
}

function chooseLast(...values) {
	let last = 5;
	for (const value of values) {
		if (value > 0) {
			last = 7;
			continue;
		}
		last = 11;
	}
	return last;
}

const scenario = process.env.REST_ITERATION_CASE ?? "numbers";
switch (scenario) {
	case "numbers":
		check(sum(3, 5, 7, 11) === 26);
		check(sum(3) === 3);
		check(sum() === undefined);
		check(Number.isNaN(sum(0, NaN)));
		check(Object.is(sum(-0, -0), -0));
		check(sum(0, Infinity) === Infinity);
		break;
	case "coercion": {
		let calls = 0;
		const value = {
			valueOf() {
				calls++;
				churn();
				return 13;
			},
		};
		check(sum(1, value, "x", 7) === "14x7");
		check(calls === 1);
		check(sum(1n, 3n, 5n) === 9n);
		break;
	}
	case "throw": {
		const marker = {};
		let calls = 0;
		try {
			sum(
				1,
				{
					valueOf() {
						calls++;
						churn();
						throw marker;
					},
				},
				7,
			);
			throw new Error("missing exception");
		} catch (error) {
			check(error === marker);
		}
		check(calls === 1);
		try {
			sum(1, 3n);
			throw new Error("missing BigInt exception");
		} catch (error) {
			check(error instanceof TypeError);
		}
		break;
	}
	case "gc":
		check(objects({ amount: 3 }, { amount: 5 }, { amount: 7 }, { amount: 11 }) === 26);
		check(objects() === 0);
		break;
	case "exits":
		check(stop(5, 2, 3, 7, 11) === 12);
		check(returning(1, 2, 3, 5) === 3);
		check(returning() === -1);
		check(sum(0, 2, 3) === 5);
		break;
	case "repeated":
		check(repeated(4, 1, 3, 5) === 54);
		check(repeated(3) === 0);
		break;
	case "escape":
		check(escape(1, 2) === 8);
		check(globalThis.savedRest.length === 3);
		check(write(1, 2, 3) === 11);
		break;
	case "forward":
		for (let index = 0; index < 8; index++) {
			check(forwardAndIterate(7, 1, 3) === 15);
			churn();
		}
		break;
	case "delayed":
		check(delayedIteration({ amount: 3 }, { amount: 5 }) === 16_264);
		churn();
		break;
	case "joins":
		check(chooseLast(1, -1) === 11);
		check(chooseLast(-1, 1) === 7);
		check(chooseLast() === 5);
		break;
	case "mutable": {
		let closes = 0;
		const original = Array.prototype[Symbol.iterator];
		Array.prototype[Symbol.iterator] = function () {
			let index = 0;
			const array = this;
			return {
				next() {
					return index < array.length
						? { value: array[index++] * 2, done: false }
						: { done: true };
				},
				return() {
					closes++;
					return { done: true };
				},
			};
		};
		try {
			check(sum(0, 1, 3) === 8);
			check(stop(2, 1, 3, 5) === 8);
			check(closes === 1);
		} finally {
			Array.prototype[Symbol.iterator] = original;
		}
		break;
	}
	default:
		throw new Error("unknown rest iteration case");
}
console.log(`rest iteration ${scenario} PASS`);
