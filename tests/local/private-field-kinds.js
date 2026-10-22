// Private field reads may use the kinds of every value any write stores in that
// field; each case below writes kinds a single class body would not suggest.
const results = [];
const kind = (value) => (value === null ? "null" : typeof value);

class Counter {
	#count = 0;
	#label;
	#enabled = true;
	constructor(label) {
		this.#label = label;
	}
	bump(by) {
		if (this.#enabled) this.#count = this.#count + by;
		return this.#count;
	}
	disable() {
		this.#enabled = false;
	}
	describe() {
		return `${this.#label}:${this.#count}:${kind(this.#label)}`;
	}
}
const counters = [new Counter("a"), new Counter(7), new Counter({ id: 1 })];
for (const counter of counters) for (let step = 0; step < 50; step++) counter.bump(step);
counters[1].disable();
counters[1].bump(1000);
counters[2].bump(0.5);
results.push(
	counters.map((counter) => counter.describe()),
	counters.map((counter) => kind(counter.bump(0))),
);

class Mixed {
	#value = 1;
	set(value) {
		this.#value = value;
	}
	read() {
		return this.#value;
	}
	twice() {
		return this.#value + this.#value;
	}
}
const mixed = new Mixed();
const seen = [mixed.twice()];
for (const value of ["x", 2n, null, undefined, true, Symbol.iterator, [3], 4.5]) {
	mixed.set(value);
	try {
		seen.push(kind(mixed.read()), String(mixed.twice()));
	} catch (error) {
		seen.push(error.constructor.name);
	}
}
results.push(seen);

class Early {
	#items;
	#size = 0;
	constructor(observe) {
		this.observed = [kind(this.peek()), this.#size];
		observe(this);
		this.#items = [1, 2, 3];
		this.#size = this.#items.length;
	}
	peek() {
		return this.#items;
	}
	size() {
		return this.#size;
	}
}
let reentered;
const early = new Early((self) => {
	reentered = [kind(self.peek()), self.size()];
});
results.push([early.observed, reentered, early.peek(), early.size()]);

function makeClass(initial) {
	return class {
		#field = initial;
		static #instances = 0;
		constructor() {
			this.constructor.#count();
		}
		static #count() {
			this.#instances++;
		}
		static instances() {
			return this.#instances;
		}
		get() {
			return this.#field;
		}
		has(other) {
			return #field in other;
		}
	};
}
const NumberBox = makeClass(1);
const StringBox = makeClass("s");
const numberBox = new NumberBox();
const stringBox = new StringBox();
new NumberBox();
results.push([
	kind(numberBox.get()),
	kind(stringBox.get()),
	numberBox.has(numberBox),
	numberBox.has(stringBox),
	NumberBox.instances(),
	StringBox.instances(),
]);

class Base {
	constructor(target) {
		return target;
	}
}
class Stamp extends Base {
	#mark = "stamped";
	static read(object) {
		return #mark in object ? object.#mark : "none";
	}
}
const plain = {};
const before = Stamp.read(plain);
new Stamp(plain);
results.push([before, Stamp.read(plain)]);
try {
	new Stamp(plain);
	results.push("restamped");
} catch (error) {
	results.push(error.constructor.name);
}

class Lazy {
	#cache = null;
	compute() {
		this.#cache ??= { total: 0 };
		this.#cache.total += 1;
		return this.#cache.total;
	}
}
const lazy = new Lazy();
results.push([lazy.compute(), lazy.compute()]);

console.log(JSON.stringify(results));
