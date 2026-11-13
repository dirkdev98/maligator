// For-of loops over a rest parameter while %Array.prototype%[@@iterator] and the
// Array iterator prototypes are intact, then with them replaced from inside a loop
// body and between calls.
const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
const IteratorPrototype = Object.getPrototypeOf(ArrayIteratorPrototype);
const originalNext = ArrayIteratorPrototype.next;
const originalIterator = Array.prototype[Symbol.iterator];

// Breaks once `stop` holds and throws past `limit`.
function collect(limit, stop, ...values) {
	let total = 0;
	let position = 0;
	for (const value of values) {
		if (value > limit) throw new RangeError(`${total} above ${limit}`);
		total += value;
		if (stop(position++, value)) break;
	}
	return total;
}

// Every caller reaches the loop through this, so it stays one site.
const collectors = [collect];
const never = () => false;
const odd = (position, value) => (value & 1) === 1;

function all(label) {
	let sums = 0;
	let odds = 0;
	const thrown = [];
	for (let seed = 0; seed < 8; seed++) {
		sums += collectors[0](1000, never, seed, seed * 3, seed * 5 + 1, 9);
		odds += collectors[0](1000, odd, seed * 2, seed + 1, 4, seed * 7);
		try {
			thrown.push(collectors[0](20, never, seed * 4, seed * 6, seed));
		} catch (error) {
			thrown.push(error.message);
		}
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
			collectors[0](1000, never, seed, round, seed + round) +
			collectors[0](1000, odd, round * 2, seed, 3);
record("warm", warm);
record("loops", loops);
all("intact");

// Inside a loop that entered with the protocol intact: the replaced `next` leaves
// the loop's captured method alone, and a `return` added to %IteratorPrototype%
// receives the Array iterator where the loop broke.
const seen = [];
record(
	"inside",
	collectors[0](
		1000,
		(position) => {
			if (position === 1) {
				ArrayIteratorPrototype.next = function () {
					seen.push("next");
					return Reflect.apply(originalNext, this, []);
				};
				IteratorPrototype.return = function (value) {
					const rest = [];
					for (
						let step = Reflect.apply(originalNext, this, []);
						!step.done;
						step = Reflect.apply(originalNext, this, [])
					)
						rest.push(step.value);
					seen.push(`return:${rest.join(" ")}`);
					return { value, done: true };
				};
			}
			return position === 3;
		},
		10,
		20,
		30,
		40,
		50,
		60,
	),
);
record("inside.seen", seen.join(","));

// Replaced before the loops run.
seen.length = 0;
all("replaced");
record("replaced.seen", seen.length);
ArrayIteratorPrototype.next = originalNext;
delete IteratorPrototype.return;
all("restored");

let iterators = 0;
Array.prototype[Symbol.iterator] = function () {
	iterators++;
	return Reflect.apply(
		originalIterator,
		[...Reflect.apply(originalIterator, this, [])].reverse(),
		[],
	);
};
all("reversed");
record("reversed.calls", iterators);
Array.prototype[Symbol.iterator] = originalIterator;
all("final");

console.log(results.join("\n"));
