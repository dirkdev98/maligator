function check(condition) {
	if (!condition) throw new Error("rest iteration mismatch");
}

function sum(base, ...values) {
	let total = base;
	for (const value of values) total += value;
	return total;
}

function subtract(base, ...values) {
	let total = base;
	for (const value of values) total -= value;
	return total;
}

function multiply(base, ...values) {
	let total = base;
	for (const value of values) total *= value;
	return total;
}

function divide(base, ...values) {
	let total = base;
	for (const value of values) total /= value;
	return total;
}

function remainder(base, ...values) {
	let total = base;
	for (const value of values) total %= value;
	return total;
}

function exponentiate(base, ...values) {
	let total = base;
	for (const value of values) total **= value;
	return total;
}

function bitAnd(base, ...values) {
	let total = base;
	for (const value of values) total &= value;
	return total;
}

function bitOr(base, ...values) {
	let total = base;
	for (const value of values) total |= value;
	return total;
}

function bitXor(base, ...values) {
	let total = base;
	for (const value of values) total ^= value;
	return total;
}

function shiftLeft(base, ...values) {
	let total = base;
	for (const value of values) total <<= value;
	return total;
}

function shiftRight(base, ...values) {
	let total = base;
	for (const value of values) total >>= value;
	return total;
}

function shiftUnsigned(base, ...values) {
	let total = base;
	for (const value of values) total >>>= value;
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
		check(sum(3, 5, 7, 11, 13) === 39);
		check(sum(3, 5, 7, 11, 13, 17) === 56);
		check(sum() === undefined);
		check(Number.isNaN(sum(0, NaN)));
		check(Object.is(sum(-0, -0), -0));
		check(sum(0, Infinity) === Infinity);
		break;
	case "arithmetic":
		check(subtract(30, 2, 3, 4, 5) === 16);
		check(subtract(30, 2, 3, 4, 5, 6) === 10);
		check(subtract(1e16, 1e16, 1) === -1);
		check(subtract(9) === 9 && subtract() === undefined);
		check(Object.is(subtract(-0, 0), -0));
		check(Number.isNaN(subtract(Infinity, Infinity)));
		check(multiply(2, 3, 4, 5, 6) === 720);
		check(multiply(2, 3, 4, 5, 6, 7) === 5040);
		check(multiply(9) === 9 && multiply() === undefined);
		check(Object.is(multiply(0, -1), -0));
		check(Number.isNaN(multiply(1e308, 1e308, 0)));
		check(multiply(2, Infinity) === Infinity);
		break;
	case "numeric operators": {
		const seed = {};
		for (const reducer of [
			divide,
			remainder,
			exponentiate,
			bitAnd,
			bitOr,
			bitXor,
			shiftLeft,
			shiftRight,
			shiftUnsigned,
		]) {
			check(reducer(3.5) === 3.5 && reducer(seed) === seed && reducer() === undefined);
		}
		check(divide(100, 2, 5) === 10);
		check(divide(1, 0) === Infinity && Number.isNaN(divide(0, 0)));
		check(Object.is(divide(-0, 1), -0));
		check(remainder(-13, 5, 2) === -1);
		check(Object.is(remainder(-4, 2), -0));
		check(exponentiate(2, 3, 2) === 64);
		check(exponentiate(NaN, 0) === 1 && Number.isNaN(exponentiate(1, Infinity)));
		check(exponentiate(-0, -3) === -Infinity);
		check(bitAnd(-1, 4294967303, 3) === 3);
		check(bitOr(4294967301, 8, 2) === 15);
		check(bitXor(4294967301, 3, 2) === 4);
		check(shiftLeft(2147483648, 1) === 0 && shiftLeft(-1, 33) === -2);
		check(shiftRight(-2147483648, 33) === -1073741824);
		check(shiftUnsigned(-1, 1, 1) === 1073741823);
		check(shiftUnsigned(4294967296, 0) === 0 && shiftUnsigned(1, -1) === 0);
		check(divide(100n, 2n, 5n) === 10n);
		check(remainder(13n, 5n, 2n) === 1n);
		check(exponentiate(2n, 3n, 2n) === 64n);
		check(bitAnd(15n, 7n, 3n) === 3n && shiftLeft(3n, 2n) === 12n);
		break;
	}
	case "arithmetic coercion": {
		const emptySeed = {};
		check(subtract(emptySeed) === emptySeed && multiply(emptySeed) === emptySeed);
		check(subtract(20n, 3n, 2n) === 15n);
		check(multiply(2n, 3n, 5n) === 30n);
		check(subtract("20", "3", "2") === 15);
		check(multiply("2", "3", "5") === 30);
		for (const reducer of [subtract, multiply]) {
			const hints = [];
			const value = {
				[Symbol.toPrimitive](hint) {
					hints.push(hint);
					churn();
					return 5;
				},
			};
			const result = reducer(100, 2, value, 3);
			check(result === (reducer === subtract ? 90 : 3000));
			check(hints.join(",") === "number");
			for (const invalid of [Symbol("invalid"), 3n]) {
				let threw = false;
				try {
					reducer(1, 2, invalid);
				} catch (error) {
					threw = error instanceof TypeError;
				}
				check(threw);
			}
		}
		break;
	}
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
		check(sum(0, 1, 3) === 4);
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
