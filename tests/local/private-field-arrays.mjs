// A private field whose values are all Arrays, or all one TypedArray kind, lets
// element accesses skip the class test. Each case below gives such an array state
// that the remaining element checks must still notice.
const results = [];
const kind = (error) => error.constructor.name;
const attempt = (action) => {
	try {
		return action();
	} catch (error) {
		return kind(error);
	}
};

class Table {
	#rows = [];
	#marks;
	#counts = new Int32Array(4);
	#copy;
	constructor(size) {
		this.#marks = Array.from({ length: size }, (_, index) => index % 3);
		this.#copy = this.#rows;
	}
	add(row) {
		this.#rows.push(row);
		return this.#copy.length;
	}
	row(index) {
		return this.#rows[index];
	}
	mark(index) {
		return this.#marks[index];
	}
	setMark(index, value) {
		this.#marks[index] = value;
	}
	count(index) {
		return this.#counts[index];
	}
	bump(index) {
		this.#counts[index] += 1;
	}
	marks() {
		return this.#marks;
	}
	size() {
		return this.#marks.length;
	}
}

function scan(table, count) {
	let sum = 0;
	for (let index = 0; index < count; index++) sum += table.mark(index) ?? 100;
	return sum;
}

const table = new Table(6);
results.push([table.add("a"), table.add("b"), table.row(0), table.row(1), table.row(2)]);
results.push([
	table.size(),
	scan(table, 6),
	scan(table, 8),
	table.mark("2"),
	table.mark(1.5),
]);

const marks = table.marks();
marks.length = 10;
results.push(scan(table, 10));
Object.setPrototypeOf(marks, Object.assign(Object.create(Array.prototype), { 7: 70 }));
results.push([scan(table, 10), table.mark(7), table.mark(8)]);
table.setMark(7, 7);
results.push([table.mark(7), table.size()]);

Object.defineProperty(marks, 1, { get: () => 11, configurable: true });
results.push([scan(table, 4), attempt(() => table.setMark(1, 5)), table.mark(1)]);

table.setMark(1000, 1);
results.push([table.size(), table.mark(1000), table.mark(999), scan(table, 3)]);

Object.freeze(marks);
results.push([attempt(() => table.setMark(2, 9)), table.mark(2)]);

for (const index of [0, 1, 1, 3, 3, 3]) table.bump(index);
results.push([0, 1, 2, 3, 4, -1, 1.5, "3"].map((index) => table.count(index)));

class Early {
	#items;
	constructor() {
		this.seen = this.peek();
		this.#items = [1, 2];
	}
	peek() {
		return this.#items;
	}
	second() {
		return this.#items[1];
	}
}
const early = new Early();
results.push([early.seen === undefined, early.second(), early.peek().length]);

console.log(JSON.stringify(results));
