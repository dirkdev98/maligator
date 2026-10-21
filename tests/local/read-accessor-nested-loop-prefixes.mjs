// A read accessor that ends in a field of an indexed element, called from an inner loop,
// keeps its prefix per inner loop entry and still sees every invalidation.
class Table {
	#rows;
	constructor(rows) {
		this.#rows = rows;
	}
	value(index) {
		return this.#rows[index].value;
	}
	retire(rows) {
		this.#rows = rows;
	}
	replaceRow(index, row) {
		this.#rows[index] = row;
	}
}

const rows = (offset) =>
	Array.from({ length: 6 }, (_, index) => ({
		value: index + offset,
		label: `r${index}`,
	}));

function scan(owner, rounds, count, after) {
	const output = [];
	for (let round = 0; round < rounds; round++) {
		for (let index = 0; index < count; index++) {
			output.push(owner.table.value(index));
			if (after) after(round, index, owner);
		}
	}
	return output;
}
globalThis.scan = scan;

const cases = [];
for (const [rounds, count] of [
	[0, 6],
	[1, 0],
	[1, 6],
	[3, 6],
])
	cases.push(globalThis.scan({ table: new Table(rows(0)) }, rounds, count, null));

for (const kind of ["retire", "method", "receiver", "row", "field", "accessor"]) {
	const owner = { table: new Table(rows(0)) };
	const values = globalThis.scan(owner, 2, 6, (round, index, receiver) => {
		if (round !== 0 || index !== 2) return;
		if (kind === "retire") receiver.table.retire(rows(100));
		else if (kind === "method") receiver.table.value = (at) => at + 1000;
		else if (kind === "receiver") receiver.table = new Table(rows(200));
		else if (kind === "row") receiver.table.replaceRow(3, { value: 77 });
		else if (kind === "field") receiver.table.replaceRow(4, { label: "no value" });
		else {
			let reads = 0;
			receiver.table.replaceRow(5, {
				get value() {
					reads++;
					return 500 + reads;
				},
			});
		}
	});
	cases.push({ kind, values });
}

const holes = rows(0);
delete holes[1];
let missing = "";
try {
	globalThis.scan({ table: new Table(holes) }, 1, 6, null);
} catch (error) {
	missing = error.constructor.name;
}
cases.push({ missing });

console.log(JSON.stringify(cases));
