// For-of loops over a private generator while %GeneratorPrototype% and
// %IteratorPrototype% are intact, then with their methods replaced from inside a
// loop body and between loops.
const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

const GeneratorPrototype = Object.getPrototypeOf(function* () {}).prototype;
const IteratorPrototype = Object.getPrototypeOf(GeneratorPrototype);
const originalNext = GeneratorPrototype.next;
const originalReturn = GeneratorPrototype.return;
const originalIterator = IteratorPrototype[Symbol.iterator];

function* sequence(seed) {
	const step = (seed & 3) + 5;
	for (let index = 0; index < 6; index++) yield (seed + index * step) & 63;
}

// Breaks once `stop` holds and throws past `limit`.
function walk(seed, limit, stop) {
	let total = 0;
	let position = 0;
	for (const value of sequence(seed | 0)) {
		if (value > limit) throw new RangeError(`${total} above ${limit}`);
		total += value;
		if (stop(position++, value)) break;
	}
	return total;
}

const odd = (position, value) => (value & 1) === 1;
const never = () => false;
// Every caller reaches the loop through this, so it stays one site.
const consumers = [walk];

function throwAbove(seed, limit) {
	try {
		return `${consumers[0](seed, limit, never)}`;
	} catch (error) {
		return error.message;
	}
}

function all(label) {
	let sums = 0;
	let odds = 0;
	const thrown = [];
	for (let seed = 0; seed < 8; seed++) {
		sums += consumers[0](seed * 5, 1000, never);
		odds += consumers[0](seed * 3, 1000, odd);
		thrown.push(throwAbove(seed * 9, 40));
	}
	record(`${label}.sum`, sums);
	record(`${label}.odd`, odds);
	record(`${label}.throw`, thrown.join(","));
}

const loops = 40;
let warm = 0;
for (let round = 0; round < loops; round++)
	for (let seed = 0; seed < 8; seed++)
		warm +=
			consumers[0](seed + round, 1000, never) + consumers[0](seed + round, 1000, odd);
record("warm", warm);
record("loops", loops);
all("intact");

// Inside a loop that entered with the protocol intact: the replaced `next` leaves
// the loop's captured method alone, and the replaced `return` receives the
// generator suspended where the loop broke.
const seen = [];
record(
	"inside",
	consumers[0](5, 1000, (position) => {
		if (position === 1) {
			GeneratorPrototype.next = function () {
				seen.push("next");
				return originalNext.call(this);
			};
			GeneratorPrototype.return = function (value) {
				const rest = [];
				for (
					let step = originalNext.call(this);
					!step.done;
					step = originalNext.call(this)
				)
					rest.push(step.value);
				seen.push(`return:${rest.join(" ")}`);
				return { value, done: true };
			};
		}
		return position === 3;
	}),
);
record("inside.seen", seen.join(","));

// Replaced before the loops run.
seen.length = 0;
all("replaced");
record("replaced.seen", seen.length);
GeneratorPrototype.next = originalNext;
GeneratorPrototype.return = originalReturn;
all("restored");

let returns = 0;
GeneratorPrototype.return = function (value) {
	returns++;
	return originalReturn.call(this, value);
};
all("return");
record("return.calls", returns);
GeneratorPrototype.return = originalReturn;

let iterators = 0;
IteratorPrototype[Symbol.iterator] = function () {
	iterators++;
	return this;
};
all("iterator");
record("iterator.calls", iterators);
IteratorPrototype[Symbol.iterator] = originalIterator;

GeneratorPrototype.next = function () {
	const step = originalNext.call(this);
	return step.done ? step : { value: step.value * 2, done: false };
};
all("doubled");
GeneratorPrototype.next = originalNext;

let getterLoads = 0;
Object.defineProperty(GeneratorPrototype, "return", {
	configurable: true,
	get() {
		getterLoads++;
		return undefined;
	},
});
all("getter");
record("getter.loads", getterLoads);
Object.defineProperty(GeneratorPrototype, "return", {
	configurable: true,
	writable: true,
	value: originalReturn,
});
all("final");

console.log(results.join("\n"));
