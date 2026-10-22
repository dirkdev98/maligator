// Arrays that only their class's private fields hold have known element kinds.
// Each case reads elements in the states those kinds must still cover: holes,
// reads past the end, truncation, aliases that store other kinds, spread copies
// and callbacks that receive the elements.
const results = [];

class Counters {
	#live = [];
	#next = [];
	#labels = [];
	#scratch;
	constructor(size) {
		for (let index = 0; index < size; index++) {
			this.#live.push(1);
			this.#next.push(index + 1 < size ? index + 1 : -1);
		}
		this.#labels[3] = 3;
		this.#scratch = [...this.#next];
	}
	walk() {
		let sum = 0;
		for (let id = 0; id >= 0; id = this.#next[id]) {
			if (this.#live[id] !== 1) continue;
			sum += id;
		}
		return sum;
	}
	kill(count) {
		for (let index = 0; index < count; index++) this.#live[index * 2] = 0;
	}
	probe(limit) {
		const seen = [];
		for (let index = -1; index <= limit; index++)
			seen.push(this.#live[index] === undefined);
		return seen.join("");
	}
	labels() {
		let text = "";
		for (let index = 0; index < 5; index++) text += `${this.#labels[index] ?? "_"},`;
		return text;
	}
	truncate(length) {
		this.#live.length = length;
		return this.#live[length] === undefined && this.#live.length === length;
	}
	spread() {
		let sum = 0;
		this.#scratch.forEach((value) => {
			sum += value;
		});
		for (const value of this.#scratch) sum += value;
		return sum + this.#scratch.indexOf(-1);
	}
}

const counters = new Counters(10);
results.push([counters.walk(), counters.probe(11), counters.labels(), counters.spread()]);
counters.kill(3);
results.push([counters.walk(), counters.truncate(4), counters.walk(), counters.probe(5)]);

class Shared {
	#numbers = [1, 2, 3];
	#alias;
	constructor() {
		this.#alias = this.#numbers;
	}
	relabel() {
		this.#alias.push("four");
		this.#alias.fill(true, 0, 1);
		this.#alias.splice(1, 1, null, 2.5);
	}
	describe() {
		const kinds = [];
		for (let index = 0; index < 6; index++) kinds.push(typeof this.#numbers[index]);
		return kinds.join(",");
	}
	total() {
		let sum = 0;
		for (let index = 0; index < this.#numbers.length; index++) {
			const value = this.#numbers[index];
			if (value === 2.5 || value === 3) sum += value;
		}
		return sum;
	}
}

const shared = new Shared();
results.push([shared.describe(), shared.total()]);
shared.relabel();
results.push([shared.describe(), shared.total()]);

class Exposed {
	#kept = [1, 2];
	#given = [3];
	given() {
		return this.#given;
	}
	merged() {
		return this.#given.concat(this.#kept).length;
	}
	first() {
		return this.#kept[0] === 1;
	}
}

const exposed = new Exposed();
exposed.given().concat = function (other) {
	other[0] = "replaced";
	return other;
};
results.push([exposed.merged(), exposed.first()]);

class Sink {
	#values = [5, 6];
	visit() {
		this.#values.forEach((value, index, array) => {
			array[index] = `${value}`;
		});
		return typeof this.#values[0];
	}
}
results.push(new Sink().visit());

console.log(JSON.stringify(results));
