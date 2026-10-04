"use strict";

// One static load site sees receivers that alternate between shapes placing
// `value` at different slots with different field representations.
const makers = [
	(index) => ({ value: index, left: 1 }),
	(index) => ({ right: "r", value: index + 0.5 }),
	(index) => ({ other: true, extra: null, value: "s" + index }),
	(index) => ({ value: { index } }),
];

function read(row) {
	return row.value;
}

const results = [];
for (const width of [2, 3, 4]) {
	const rows = Array.from({ length: 4096 }, (_, index) => makers[index % width](index));
	let matches = 0;
	for (let round = 0; round < 4; round++) {
		for (let index = 0; index < rows.length; index++) {
			const value = read(rows[index]);
			const kind = index % width;
			const expected =
				kind === 0
					? value === index
					: kind === 1
						? value === index + 0.5
						: kind === 2
							? value === "s" + index
							: value.index === index;
			if (expected) matches++;
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
