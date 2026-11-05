const reads = [];

function total(rows, rounds) {
	let sum = 0;
	for (let round = 0; round < rounds; round++) {
		for (const row of rows) sum += row.value;
	}
	return sum;
}

function branchRows(count) {
	return Array.from({ length: count }, (_, index) =>
		index & 1 ? { value: index, left: 1 } : { value: index * 0.5, right: 2 },
	);
}

function withGetter(count) {
	const rows = branchRows(count);
	rows[count >> 1] = {
		get value() {
			reads.push("getter");
			return 1000;
		},
		left: 3,
	};
	return rows;
}

function withOtherKeyFirst(count) {
	const rows = branchRows(count);
	rows[3] = { other: 7, value: 11 };
	return rows;
}

function withDictionaryRow(count) {
	const rows = branchRows(count);
	const row = { value: 5, left: 1, extra: 2 };
	delete row.extra;
	rows[5] = row;
	return rows;
}

function withInheritedValue(count) {
	const rows = branchRows(count);
	rows[7] = Object.create({ value: 21 });
	return rows;
}

const outputs = [
	total(branchRows(64), 6),
	total(withGetter(64), 6),
	total(withOtherKeyFirst(64), 6),
	total(withDictionaryRow(64), 6),
	total(withInheritedValue(64), 6),
];
console.log(JSON.stringify({ outputs, reads: reads.length }));
