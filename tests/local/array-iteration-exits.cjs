"use strict";

// for-of loops over Arrays that leave through break, return, labeled jumps or the
// iterator's close, over the element kinds a numeric region admits and those it hands
// back to the original loop.

function findAbove(values, limit) {
	for (const value of values) if (value > limit) return value;
	return -1;
}

function indexAbove(values, limit) {
	let index = 0;
	for (const value of values) {
		if (value > limit) return index;
		index++;
	}
	return -1;
}

function includes(values, target) {
	for (const value of values) if (value === target) return true;
	return false;
}

function sumUntil(values, limit) {
	let total = 0;
	for (const value of values) {
		if (value > limit) break;
		total += value;
	}
	return total;
}

function wrappedUntil(values, limit) {
	let total = 0;
	for (const value of values) {
		if (value > limit) break;
		total = (total + value) | 0;
	}
	return total;
}

function productUntil(values, limit) {
	let product = 1;
	let count = 0;
	for (const value of values) {
		if (count === limit) break;
		product *= value;
		count++;
	}
	return [product, count];
}

function lastBefore(values, limit) {
	let last = 0;
	for (const value of values) {
		last = value;
		if (value >= limit) break;
	}
	return last;
}

function nestedBlockBreak(values, limit) {
	let odd = 0;
	let total = 0;
	for (const value of values) {
		if (value > limit) {
			if ((value & 1) === 0) break;
			odd++;
		}
		total += value;
	}
	return [odd, total];
}

function skipOdd(values, stop) {
	let total = 0;
	for (const value of values) {
		if (value & 1) continue;
		if (value === stop) break;
		total += value;
	}
	return total;
}

function rowsUntilNegative(rows) {
	let total = 0;
	outer: for (const row of rows) {
		for (const value of row) {
			if (value < 0) continue outer;
			total += value;
		}
		total += 1000;
	}
	return total;
}

function rowsBreakOuter(rows, limit) {
	let total = 0;
	let seen = 0;
	outer: for (const row of rows) {
		seen++;
		for (const value of row) {
			if (value > limit) break outer;
			total += value;
		}
	}
	return [total, seen];
}

function rowsInnerBreak(rows) {
	let total = 0;
	for (const row of rows) {
		for (const value of row) {
			if (value < 0) break;
			total += value;
		}
	}
	return total;
}

let finallyCount = 0;

function returnThroughFinally(values, limit) {
	try {
		for (const value of values) if (value > limit) return value;
		return -1;
	} finally {
		finallyCount++;
	}
}

function finallyInBody(values, limit) {
	let total = 0;
	let finished = 0;
	for (const value of values) {
		try {
			if (value > limit) return [value, total, finished];
			total += value;
		} finally {
			finished++;
		}
	}
	return [-1, total, finished];
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

const ints = Array.from({ length: 300 }, (_, index) => index * 3 - 200);
const cases = {
	ints,
	empty: [],
	floats: Array.from({ length: 64 }, (_, index) => index * 0.75 - 7.5),
	firstDouble: [0.5, 1, 2, 3, 400, 5],
	lateDouble: [1, 2, 3, 4.5, 400, 6],
	negativeZero: [1, -0, 3, 400, -0],
	nan: [1, NaN, 3, 400],
	infinite: [1, Infinity, 3, -Infinity],
	unsigned: [0xffffffff, 0x80000000, 3, 400],
	wide: [2 ** 40, 1, 2 ** 33, 400],
	beyondSafe: [2 ** 52, 2 ** 52, 2 ** 52, 3, 400, 2 ** 53],
	fractions: [0.1, 0.2, 0.3, 400.5, 0.4],
	holes: [1, , 3, 400, , 6],
	trailingHoles: Object.assign([1, 2, 3], { length: 6 }),
	strings: [1, "2", 3, 400],
	others: [1, true, null, undefined, 3, 400],
};
for (const [name, values] of Object.entries(cases)) {
	show(`${name} find`, [findAbove(values, 100), findAbove(values, 1e300)]);
	show(`${name} index`, [indexAbove(values, 100), indexAbove(values, -1)]);
	show(`${name} includes`, [
		includes(values, 3),
		includes(values, -0),
		includes(values, 7),
	]);
	show(`${name} until`, [sumUntil(values, 100), sumUntil(values, Infinity)]);
	show(`${name} wrapped`, [wrappedUntil(values, 100), wrappedUntil(values, 0.5)]);
	show(`${name} product`, [productUntil(values, 3), productUntil(values, 100)]);
	show(`${name} last`, [lastBefore(values, 100), lastBefore(values, 1e300)]);
	show(`${name} block`, nestedBlockBreak(values, 2));
	show(`${name} skip`, [skipOdd(values, 400), skipOdd(values, -1)]);
	show(`${name} finally`, [
		returnThroughFinally(values, 100),
		finallyInBody(values, 100),
	]);
}
show("finally count", finallyCount);

const rows = Array.from({ length: 12 }, (_, row) =>
	Array.from({ length: 8 }, (_, index) => (index === 7 - (row % 3) ? -1 : index + row)),
);
show("rows", [rowsUntilNegative(rows), rowsBreakOuter(rows, 14), rowsInnerBreak(rows)]);
rows[4][2] = 2.5;
rows[5][1] = "1";
show("mixed rows", [
	rowsUntilNegative(rows),
	rowsBreakOuter(rows, 14),
	rowsInnerBreak(rows),
]);

let conversions = 0;
const counted = {
	valueOf() {
		conversions++;
		return 500;
	},
};
show("coercion", [
	findAbove([1, counted, 3], 100),
	sumUntil([1, counted, 3], 100),
	conversions,
]);

// A getter on a hole runs inside the original loop that a region hands it back to.
const shrinking = [1, 2, 3, 4, 5, 6, 7, 8];
delete shrinking[3];
Object.defineProperty(shrinking, 3, {
	get() {
		shrinking.length = 5;
		return 4;
	},
	configurable: true,
});
show("shrinking", [sumUntil(shrinking, 100), shrinking.length, sumUntil(shrinking, 3)]);

const replaced = ints.slice();
replaced[Symbol.iterator] = function* () {
	try {
		yield 7;
		yield 700;
		yield 8;
	} finally {
		show("replaced closed", true);
	}
};
show("replaced iterator", [findAbove(replaced, 100), sumUntil(replaced, 100)]);

// A leading fraction sends one iteration to doubles before the integers resume.
const leadingFraction = [0.5, ...ints.slice(1)];
const rounds = 64;
let checksum = 0;
for (let round = 0; round < rounds; round++) {
	checksum = (checksum + findAbove(ints, 600) + indexAbove(ints, round)) | 0;
	checksum = (checksum + sumUntil(ints, 500) + wrappedUntil(ints, 400)) | 0;
	checksum = (checksum + rowsInnerBreak(rows) + wrappedUntil(leadingFraction, 400)) | 0;
}
show("checksum", checksum);
console.log(`rounds=${rounds}`);
