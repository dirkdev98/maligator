"use strict";

function scatter(source, target, factor, carry) {
	let index = 0;
	let destination = 0;
	let count = source.length;
	while (--count >= 0) {
		carry = source[index++] * factor + carry;
		target[destination++] = carry | 0;
	}
	return [target, carry, index, destination];
}

function lastProduct(source, factor) {
	let index = 0;
	let result = 1;
	let bits = 0;
	while (index < source.length) {
		bits ^= index;
		result = source[index++] * factor;
	}
	return [Object.is(result, -0), result, bits, Number.isNaN(result), result === Infinity];
}

function divide(source, divisor, carry) {
	let index = 0;
	let bits = 0;
	while (index < source.length) {
		carry = carry / divisor + source[index++];
		bits ^= index;
	}
	return [carry, bits];
}

function storeThenMultiply(array, value) {
	let count = 1;
	while (count-- > 0) {
		array[0] = (array[0] + 1) | 0;
		value = value * 3;
	}
	return [array[0], value];
}

function shiftedBigInt(input, shift) {
	const value = input >> shift;
	return value < 0n ? value * -3n : value * 2n;
}

console.log("integer", JSON.stringify(scatter([1, 2, 3], [0, 0, 0], 3, 7)));
console.log("negative", JSON.stringify(lastProduct([-2], 3)));
console.log("fraction", JSON.stringify(scatter([1, 2.5, 3], [0, 0, 0], 3, 7)));
console.log("wide", JSON.stringify(lastProduct([Number.MAX_SAFE_INTEGER], 3)));
console.log("unsigned", JSON.stringify(lastProduct([0xffffffff], 3)));
console.log("past unsigned", JSON.stringify(lastProduct([2 ** 32], 3)));
console.log("wide carry", JSON.stringify(scatter([1, 2, 3], [0, 0, 0], 3, 2 ** 40)));
console.log("negative zero", JSON.stringify(lastProduct([0], -1)));
console.log("input zero", JSON.stringify(lastProduct([-0], 1)));
console.log("infinity", JSON.stringify(lastProduct([Infinity], 1)));
console.log("nan", JSON.stringify(lastProduct([NaN], 1)));
console.log("fractional division", JSON.stringify(divide([1, 2, 3], 2, 7)));
console.log("division by zero", JSON.stringify(divide([1, 2], 0, 7)));
console.log(
	"post-store",
	JSON.stringify(storeThenMultiply([0], Number.MAX_SAFE_INTEGER)),
);
console.log("bigint", String(shiftedBigInt(16n, 2n)), String(shiftedBigInt(-16n, 1n)));

let conversions = 0;
const boxed = {
	valueOf() {
		conversions++;
		return 2.5;
	},
};
console.log(
	"coercion",
	JSON.stringify(scatter([1, boxed, 3], [0, 0, 0], 3, 7)),
	conversions,
);
