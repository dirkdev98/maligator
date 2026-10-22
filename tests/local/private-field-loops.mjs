// Loops may reuse a private field value read before the loop when only the
// activation that added the field can store into it; each case below changes or
// adds a field while such a loop runs.
const results = [];
const kind = (error) => error.constructor.name;

class Base {
	constructor(target) {
		return target;
	}
}

// super() binds `this` before defining fields, so a caught definition failure lets
// this constructor store into a field that an earlier construction added.
class Restamp extends Base {
	#mark = "first";
	constructor(target, mark) {
		try {
			super(target);
		} catch {}
		this.#mark = mark;
	}
	static read(object) {
		return object.#mark;
	}
}

// Calls through a runtime-built table stay opaque to the reading loop.
const hooks = [];
for (const mark of ["changed"]) hooks.push((object) => new Restamp(object, mark));
hooks.push(() => hooks.length);

function readMarks(object) {
	const marks = [];
	for (let step = 0; step < 4; step++) {
		marks.push(Restamp.read(object));
		if (step === 1) hooks[0](object);
	}
	return marks;
}
const stamped = {};
new Restamp(stamped, "initial");
results.push(readMarks(stamped));

class Stamp extends Base {
	#tag = "tagged";
	static tagOf(object) {
		return #tag in object ? object.#tag : "none";
	}
}

function readTags(object) {
	const tags = [];
	for (let step = 0; step < 4; step++) {
		tags.push(Stamp.tagOf(object));
		if (step === 1) new Stamp(object);
	}
	return tags;
}
results.push(readTags({}));

class Cell {
	#value;
	#history = [];
	constructor(value) {
		this.#value = value;
		this.#history.push(value);
	}
	value() {
		return this.#value;
	}
	history() {
		return this.#history;
	}
	static read(object) {
		return object.#value;
	}
}

function sumWithFreshCells(anchor) {
	let total = 0;
	const made = [];
	for (let step = 0; step < 6; step++) {
		const fresh = new Cell(step);
		total += anchor.value() + fresh.value();
		anchor.history().push(step);
		made.push(fresh);
	}
	return [total, made.map((cell) => cell.value()), anchor.history()];
}

function readCells(object, count) {
	const reads = [];
	for (let step = 0; step < count; step++) reads.push(Cell.read(object));
	return reads;
}
const anchor = new Cell(5);
let strangeReads;
try {
	strangeReads = readCells({}, 2);
} catch (error) {
	strangeReads = kind(error);
}
results.push(sumWithFreshCells(anchor), strangeReads, readCells(anchor, 2));

// The adding activation may store into its own field inside the loop.
class Counter {
	#count = 0;
	constructor(limit) {
		for (let step = 0; step < limit; step++) {
			this.#count = this.#count + 1;
			hooks[1]();
		}
	}
	count() {
		return this.#count;
	}
}

function countTo(limit) {
	return new Counter(limit).count();
}
results.push([new Counter(5).count(), countTo(7)]);

// A derived constructor's `this` exists only once super() returns.
class Deferred extends Base {
	#value = "set";
	constructor(target, log) {
		for (let step = 0; step < 3; step++) {
			if (step === 1) super(target);
			try {
				log.push(this.#value);
			} catch (error) {
				log.push(kind(error));
			}
		}
	}
}
const deferredLog = [];
new Deferred({}, deferredLog);
results.push(deferredLog);

// A generator or async reader can resume after its constructor stores a new value.
class Feed {
	#value = 1;
	constructor(log) {
		const reader = this.#reader();
		log.push(reader.next().value);
		this.#value = 2;
		log.push(reader.next().value);
	}
	*#reader() {
		for (let step = 0; step < 2; step++) yield this.#value;
	}
}
const feedLog = [];
new Feed(feedLog);
results.push(feedLog);

class Later {
	#value = "before";
	constructor(log) {
		this.done = this.#watch(log);
		this.#value = "after";
	}
	async #watch(log) {
		for (let step = 0; step < 2; step++) {
			log.push(this.#value);
			await null;
		}
	}
}

// Each evaluation of the class body creates new private names.
function makeBox() {
	return class {
		#value;
		#scale = 2;
		constructor(value) {
			this.#value = value;
		}
		static sum(box, count) {
			let sum = 0;
			for (let step = 0; step < count; step++) sum += box.#value * box.#scale;
			return sum;
		}
	};
}
const sums = [];
for (let round = 0; round < 3; round++) {
	const Box = makeBox();
	sums.push(Box.sum(new Box(round + 1), 3));
	try {
		sums.push(Box.sum(new (makeBox())(1), 2));
	} catch (error) {
		sums.push(kind(error));
	}
}
results.push(sums);

const laterLog = [];
new Later(laterLog).done.then(() => {
	results.push(laterLog);
	console.log(JSON.stringify(results));
});
