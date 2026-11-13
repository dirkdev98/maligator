// Typed array loops over views built through mutable global constructors, which a
// program may replace with another kind, a subclass or a plain Array builder.
const results = [];
function record(label, value) {
	results.push(`${label}=${Object.is(value, -0) ? "-0" : String(value)}`);
}

const OriginalUint32Array = Uint32Array;
const OriginalFloat64Array = Float64Array;

function fill(round) {
	const integers = new Uint32Array(64);
	const floats = new Float64Array(64);
	for (let index = 0; index < integers.length; index++) {
		integers[index] = (round * 37 + index * 17 - 5) >>> 0;
		floats[index] = integers[index] * 0.25 + index;
	}
	let sum = 0;
	for (let index = 0; index < integers.length; index++)
		sum += integers[index] + floats[index] * 2;
	return sum;
}

const loops = 40;
let warm = 0;
for (let round = 0; round < loops; round++) warm += fill(round);
record("warm", warm);
record("loops", loops);

// Another kind under the same names: Uint32Array now clamps bytes, Float64Array rounds.
globalThis.Uint32Array = Uint8ClampedArray;
globalThis.Float64Array = Float32Array;
record("swapped", fill(3));
globalThis.Uint32Array = OriginalUint32Array;
globalThis.Float64Array = OriginalFloat64Array;
record("restored", fill(3));

// A subclass keeps the kind but observes its construction.
let constructed = 0;
globalThis.Uint32Array = class extends OriginalUint32Array {
	constructor(length) {
		constructed++;
		super(length);
	}
};
record("subclass", fill(5));
record("subclass.constructed", constructed);
globalThis.Uint32Array = OriginalUint32Array;

// A function returning a plain Array, whose elements stay Numbers.
globalThis.Float64Array = function (length) {
	return Array.from({ length }, () => 0);
};
record("array", fill(7));
globalThis.Float64Array = OriginalFloat64Array;
record("final", fill(7));

console.log(results.join("\n"));
