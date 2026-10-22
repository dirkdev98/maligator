// Module constants that hold one Array or TypedArray class keep that class for
// every read. Each case reads them in the states the class must still cover:
// before initialization, past the end, after a detach and with accessor or
// truncated elements.
const results = [];

function earlyFlag() {
	return FLAGS[1];
}
try {
	results.push(earlyFlag());
} catch (error) {
	results.push(error.constructor.name);
}

const FLAGS = new Uint8Array(8);
const TABLE = new Float64Array(4);
const BYTES = new Int16Array(new ArrayBuffer(8));
const LIST = [1, 2, 3];
const DERIVED = new (class extends Uint8Array {
	get length() {
		return 99;
	}
})(2);

function mark(limit) {
	for (let index = 0; index < limit; index++) FLAGS[index] = index * 70;
	let sum = 0;
	for (let index = -1; index <= FLAGS.length; index++) sum += FLAGS[index] ?? 1000;
	return [sum, FLAGS[1.5] === undefined];
}

function scale(factor) {
	for (let index = 0; index < TABLE.length; index++) TABLE[index] = index / factor;
	return [TABLE[3], TABLE[4]];
}

function detach() {
	const before = BYTES.length;
	BYTES[0] = -7;
	const read = BYTES[0];
	BYTES.buffer.transfer();
	return [before, read, BYTES.length, BYTES[0]];
}

function walk() {
	let sum = 0;
	for (let index = 0; index < LIST.length; index++) sum += LIST[index] ?? 0;
	return sum;
}

results.push(mark(8), mark(3), scale(4), String(scale(0)));
results.push(...detach());
results.push(walk());
LIST[5] = "five";
results.push(walk(), String(LIST));
Object.defineProperty(LIST, 1, { get: () => 40 });
results.push(walk());
LIST.length = 1;
results.push(walk(), DERIVED.length, DERIVED[1]);
console.log(JSON.stringify(results));
