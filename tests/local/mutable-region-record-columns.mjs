// Record loops over `Array.from` results, whose columns hold field updates only while
// the records stay private to the loop. A replaced `Array.from` or `Array` may return
// records the program also reaches elsewhere.
const results = [];
function record(label, value) {
	results.push(`${label}=${Object.is(value, -0) ? "-0" : String(value)}`);
}

const OriginalArray = Array;
const originalFrom = Array.from;
let shared = [];
let observed = 0;
function observe() {
	for (const entry of shared) observed += entry.position.x;
}

function simulate(rounds) {
	const records = Array.from({ length: 64 }, (_, id) => ({
		id,
		position: { x: id * 0.5, y: id & 7 },
		velocity: (id & 3) - 1,
	}));
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		for (const entry of records) {
			const { position } = entry;
			position.x += entry.velocity;
			position.y = (position.y + round) & 255;
			checksum += Math.trunc(position.x) + position.y;
		}
		observe();
	}
	return checksum;
}

const loops = 40;
record("intact", simulate(loops));
record("loops", loops);

// A subclass constructor makes the realm's own `Array.from` build its result through
// user code that keeps it.
globalThis.Array = class extends OriginalArray {
	constructor(...args) {
		super(...args);
		shared = this;
	}
};
observed = 0;
record("subclass", simulate(6));
record("subclass.observed", observed);

// Another global `Array` whose `from` keeps the records it returns.
globalThis.Array = {
	from(source, map) {
		shared = originalFrom.call(OriginalArray, source, map);
		return shared;
	},
};
observed = 0;
record("global-object", simulate(6));
record("global-object.observed", observed);
globalThis.Array = OriginalArray;
shared = [];
observed = 0;
record("restored", simulate(6));
record("restored.observed", observed);

// Replacing the method itself mutates a builtin.
Array.from = function (source, map) {
	shared = originalFrom.call(OriginalArray, source, map);
	return shared;
};
observed = 0;
record("replaced-from", simulate(6));
record("replaced-from.observed", observed);
Array.from = originalFrom;

console.log(results.join("\n"));
