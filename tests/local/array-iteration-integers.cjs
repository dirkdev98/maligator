"use strict";

function wrappedSum(values) {
	let total = 0;
	for (const value of values) total = (total + value) | 0;
	return total;
}

function sumFrom(values, total) {
	for (const value of values) total = (total + value) | 0;
	return total;
}

function hash(values) {
	let state = 17;
	for (const value of values)
		state = ((state << 5) - state + value) ^ (state >>> 3) ^ (value >> 1);
	return state;
}

function masks(values) {
	let odd = 0;
	let high = 0;
	let low = 0;
	for (const value of values) {
		odd = (odd + (value & 1)) | 0;
		high ^= value >>> 16;
		low = (low | (value << 28)) & ~7;
	}
	return [odd, high, low];
}

function compare(values, limit) {
	let above = 0;
	let equal = 0;
	let bits = 0;
	for (const value of values) {
		if (value > limit) above++;
		if (value === limit) equal++;
		bits ^= value;
	}
	return [above, equal, bits];
}

function lastQuotient(values, divisor) {
	let bits = 0;
	let quotient = 0;
	let remainder = 0;
	for (const value of values) {
		bits |= value;
		quotient = value / divisor;
		remainder = value % divisor;
	}
	return [bits, quotient, remainder, Object.is(remainder, -0)];
}

function negated(values) {
	let bits = 0;
	let last = 0;
	for (const value of values) {
		bits ^= value;
		last = -value;
	}
	return [bits, last, Object.is(last, -0)];
}

function unbounded(values) {
	let sum = 0;
	let bits = 0;
	for (const value of values) {
		sum += value;
		bits ^= value;
	}
	return [sum, bits];
}

function untilAbove(values, limit) {
	let state = 0;
	let count = 0;
	for (const value of values) {
		if (value > limit) break;
		state = (state * 31 + value) | 0;
		count++;
	}
	return [state, count];
}

function fieldSum(points) {
	let total = 0;
	for (const point of points) total = (total + point.x) | 0;
	return total;
}

function destructured(points) {
	let total = 0;
	for (const { x, y } of points) total = (total + (x ^ y)) | 0;
	return total;
}

class Point {
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}
}

function classFieldSum(points) {
	let total = 0;
	for (const point of points) total = (total + (point.x >> 1)) | 0;
	return total;
}

function truncating(values) {
	let total = 0;
	for (const value of values) {
		total = (total + value) | 0;
		if (value === 3) values.length = 4;
	}
	return total;
}

function growing(values) {
	let total = 0;
	for (const value of values) {
		total = (total + value) | 0;
		if (value === 2) values.push(100);
	}
	return total;
}

function show(label, value) {
	console.log(
		label,
		JSON.stringify(value, (_, item) =>
			typeof item === "number" && (Object.is(item, -0) || !Number.isFinite(item))
				? Object.is(item, -0)
					? "-0"
					: String(item)
				: item,
		),
	);
}

const ints = Array.from({ length: 1000 }, (_, index) => index * 7919 - 3_000_000);
const cases = {
	ints,
	empty: [],
	wrap: [0x7fffffff, 1, 0x7fffffff, 0x7fffffff, -0x80000000, -1],
	unsigned: [0xffffffff, 0x80000000, 3, 0xdeadbeef],
	wide: [2 ** 40, 1, 2],
	maxSafe: [Number.MAX_SAFE_INTEGER, 1, 1],
	mixed: [1, 2, 2.5, 3, 4],
	nan: [1, NaN, 3],
	negativeZero: [1, -0, 3],
	fraction: [1, 2, 0.25, -0.75],
	infinite: [1, Infinity, -Infinity, 1e300],
	holes: [1, , 3, , 5],
	trailingHoles: Object.assign([1, 2, 3], { length: 6 }),
	strings: [1, "2", 3],
	others: [1, true, null, undefined, 3],
};
for (const [name, values] of Object.entries(cases)) {
	show(`${name} sum`, [wrappedSum(values), sumFrom(values, 0.5), sumFrom(values, -7)]);
	show(`${name} hash`, hash(values));
	show(`${name} masks`, masks(values));
	show(`${name} compare`, compare(values, 3));
	show(`${name} quotient`, [
		lastQuotient(values, 3),
		lastQuotient(values, -1),
		lastQuotient(values, 0),
	]);
	show(`${name} negated`, negated(values));
	show(`${name} unbounded`, unbounded(values));
	show(`${name} until`, untilAbove(values, 1000));
}

let conversions = 0;
const counted = {
	valueOf() {
		conversions++;
		return 5;
	},
};
show("coercion", [wrappedSum([1, counted, 3]), hash([1, counted, 3]), conversions]);
try {
	wrappedSum([1, 2n]);
} catch (error) {
	show("bigint", error.constructor.name);
}

const points = Array.from({ length: 64 }, (_, index) => ({ x: index * 3, y: index & 5 }));
show("fields", [fieldSum(points), destructured(points)]);
points[9] = { x: 1.5, y: 2 };
show("fractional field", [fieldSum(points), destructured(points)]);
points[10] = { y: 2 };
show("missing field", [fieldSum(points), destructured(points)]);
const instances = Array.from({ length: 64 }, (_, index) => new Point(index * 5, index));
show("class fields", classFieldSum(instances));
instances[7].x = 0x80000000;
show("unsigned class field", classFieldSum(instances));
instances[8].x = -0;
show("negative zero class field", classFieldSum(instances));

const shrinking = [1, 2, 3, 4, 5, 6];
show("shrinking", [wrappedSum(shrinking), truncating(shrinking), shrinking.length]);
show("shrunk", wrappedSum(shrinking));
const grown = [1, 2, 3];
show("growing", [growing(grown), grown.length, wrappedSum(grown)]);
grown.length = 1;
show("regrown", wrappedSum(grown));

let checksum = 0;
for (let round = 0; round < 64; round++) checksum = (checksum + wrappedSum(ints)) | 0;
show("checksum", checksum);

const inherited = [1, , 3, , 5];
Object.setPrototypeOf(
	inherited,
	Object.assign(Object.create(Array.prototype), { 1: 40 }),
);
show("inherited hole", [wrappedSum(inherited), hash(inherited)]);
const replaced = ints.slice();
replaced[Symbol.iterator] = function* () {
	yield 7;
	yield 0x7fffffff;
};
show("replaced iterator", [wrappedSum(replaced), hash(replaced)]);
