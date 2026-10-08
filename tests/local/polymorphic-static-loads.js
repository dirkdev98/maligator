"use strict";

// One static load site sees receivers that alternate between shapes placing
// `value` at different slots with different field representations. Past four
// shapes the site is megamorphic and also sees inherited, absent, and
// dictionary-mode `value` properties.
const inherited = { value: "inherited" };
const makers = [
	(index) => ({ value: index, left: 1 }),
	(index) => ({ right: "r", value: index + 0.5 }),
	(index) => ({ other: true, extra: null, value: "s" + index }),
	(index) => ({ value: { index } }),
	(index) => ({ a: 1, b: 2, c: 3, value: index * 2 }),
	() => Object.create(inherited),
	(index) => ({ absent: index }),
	(index) => {
		const row = { value: index - 1, removed: 0 };
		delete row.removed;
		return row;
	},
];
const expectations = [
	(value, index) => value === index,
	(value, index) => value === index + 0.5,
	(value, index) => value === "s" + index,
	(value, index) => value.index === index,
	(value, index) => value === index * 2,
	(value) => value === "inherited",
	(value) => value === undefined,
	(value, index) => value === index - 1,
];

function read(row) {
	return row.value;
}

const results = [];
for (const width of [2, 3, 4, 8]) {
	const rows = Array.from({ length: 4096 }, (_, index) => makers[index % width](index));
	let matches = 0;
	for (let round = 0; round < 4; round++) {
		for (let index = 0; index < rows.length; index++) {
			if (expectations[index % width](read(rows[index]), index)) matches++;
		}
	}
	results.push([`${width} alternating shapes`, matches === 4 * 4096]);
}

const mutable = [
	{ value: 1, a: 0 },
	{ b: 0, value: 2 },
];
let observed = 0;
for (let round = 0; round < 1000; round++) {
	const row = mutable[round & 1];
	if (read(row) === (round & 1) + 1 + (round >= 500 ? 10 : 0)) observed++;
	if (round === 499) {
		mutable[0].value = 11;
		mutable[1].value = 12;
	}
}
results.push(["writes through alternate shapes", observed === 1000]);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
