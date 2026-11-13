// Warm iteration loops after a polyfill installed unrelated methods on watched
// built-ins. Locked primordials reject the installs, which change no result here.
const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

function polyfill(target, name, value) {
	if (Object.isFrozen(target)) return;
	Object.defineProperty(target, name, { value, writable: true, configurable: true });
}
polyfill(Array.prototype, "myHelper", function () {
	return this.length;
});
polyfill(String.prototype, "myHelper", function () {
	return this.length;
});
polyfill(Object.prototype, "myHelper", () => "object");
polyfill(Math, "clampTo", (value, low, high) => Math.min(Math.max(value, low), high));
if (!Object.isFrozen(Array.prototype)) {
	Array.prototype.myOther = function () {
		return this.length * 2;
	};
}
if (
	!Object.isFrozen(Array.prototype) &&
	[[1, 2].myHelper(), "abc".myHelper(), {}.myHelper(), [1].myOther()].join() !==
		"2,3,object,2"
) {
	throw new Error("polyfills were not installed");
}

function sumArray(values) {
	let total = 0;
	for (const value of values) total += value;
	return total;
}

function countString(text) {
	let total = 0;
	for (const character of text) total += character.codePointAt(0) & 7;
	return total;
}

function* sequence(seed) {
	for (let index = 0; index < 6; index++) yield (seed + index * 5) & 63;
}

function sumSequence(seed) {
	let total = 0;
	for (const value of sequence(seed | 0)) total += value;
	return total;
}

function sumRest(...values) {
	let total = 0;
	for (const value of values) total += value;
	return total;
}

function simulate(records, rounds) {
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		for (const entry of records) {
			const { position } = entry;
			position.x += entry.velocity;
			checksum += Math.trunc(position.x) + position.y;
		}
	}
	return checksum;
}

const numbers = Array.from({ length: 32 }, (_, index) => index * 3);
const records = Array.from({ length: 32 }, (_, id) => ({
	position: { x: id * 0.5, y: id & 7 },
	velocity: (id & 3) - 1,
}));
const loops = 200;
let arrays = 0;
let strings = 0;
let sequences = 0;
let rests = 0;
for (let round = 0; round < loops; round++) {
	arrays += sumArray(numbers);
	strings += countString("polyfilled ✓ text");
	sequences += sumSequence(round);
	rests += sumRest(round, 1, 2, 3);
}
record("arrays", arrays);
record("strings", strings);
record("sequences", sequences);
record("rests", rests);
record("records", simulate(records, loops));
record("loops", loops);

console.log(results.join("\n"));
