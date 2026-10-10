function check(condition, message) {
	if (!condition) throw new Error(`FAIL ${message}`);
}

class Columns {
	#opcodes;
	#counts;
	static #created = 0;

	constructor(opcodes, counts) {
		this.#opcodes = opcodes;
		this.#counts = counts;
		Columns.#created++;
	}

	opcode(index) {
		return this.#opcodes[index];
	}

	count(index) {
		return this.#counts[index] ?? 0;
	}

	get #width() {
		return this.#opcodes.length;
	}

	#scaled(index) {
		return this.opcode(index) * this.#width;
	}

	scaled(index) {
		return this.#scaled(index);
	}

	static created() {
		return Columns.#created;
	}

	static owns(value) {
		return #opcodes in value;
	}
}

class Store {
	constructor(columns) {
		this.columns = columns;
	}
}

function scan(store, length) {
	let total = 0;
	for (let index = 0; index < length; index++)
		total = (total + store.columns.opcode(index) * store.columns.count(index)) | 0;
	return total;
}

const opcodes = [];
const counts = [];
for (let index = 0; index < 64; index++) {
	opcodes.push(index % 7);
	counts.push(index % 3);
}
const store = new Store(new Columns(opcodes, counts));
let reference = 0;
for (let index = 0; index < 64; index++)
	reference = (reference + opcodes[index] * counts[index]) | 0;
for (let round = 0; round < 50; round++)
	check(scan(store, 64) === reference, "inlined private accessors");
check(store.columns.count(99) === 0, "nullish default");
check(store.columns.scaled(3) === 3 * 64, "private method and getter");
check(Columns.owns(store.columns) && !Columns.owns({}), "brand check");
check(Columns.created() === 1, "static private field");

class Impostor {
	#opcodes = [42];
	opcode(index) {
		return this.#opcodes[index];
	}
	count() {
		return 2;
	}
}
check(scan(new Store(new Impostor()), 1) === 84, "a same-named method on another class");
let threw = false;
try {
	Columns.prototype.opcode.call(new Impostor(), 0);
} catch (error) {
	threw = error instanceof TypeError;
}
check(threw, "foreign receiver fails the brand");

function makeBrand(mark) {
	return class {
		#mark = mark;
		static read(value) {
			return #mark in value ? value.#mark : -1;
		}
	};
}
const brands = [];
for (let round = 0; round < 3; round++) brands.push(makeBrand(round));
const first = new brands[0]();
check(brands[0].read(first) === 0, "a factory class reads its own instance");
check(brands[1].read(first) === -1, "each factory evaluation mints its own names");

class Base {
	#value = "base";
	baseValue() {
		return this.#value;
	}
}
class Derived extends Base {
	#value = "derived";
	derivedValue() {
		return this.#value;
	}
	nested() {
		const outer = this;
		return new (class {
			read() {
				return outer.#value;
			}
		})().read();
	}
}
const derived = new Derived();
check(derived.baseValue() === "base", "inherited private field");
check(derived.derivedValue() === "derived", "shadowing private field");
check(derived.nested() === "derived", "nested class reads the outer private");

console.log("module-private-classes PASS");
