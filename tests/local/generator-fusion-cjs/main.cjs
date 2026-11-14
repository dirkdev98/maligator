// CommonJS top-level bindings live in the module wrapper's scope. A generator and a
// rest helper that only this module calls are as private as an ES module's.
const counter = require("./counter.cjs");

function* privateSequence(seed) {
	for (let index = 0; index < 12; index++) yield (seed + index * 7) & 255;
}

function privateTotal(base, ...values) {
	let sum = base;
	for (const value of values) sum += value;
	return sum;
}

function sumSequences(rounds) {
	let checksum = 0;
	for (let round = 0; round < rounds; round++) {
		for (const value of privateSequence(round)) checksum += value;
		for (const value of privateSequence(round)) {
			if (value & 1) continue;
			checksum += value;
			if (value > 200) break;
		}
	}
	return checksum;
}

function sumRest(rounds) {
	let checksum = 0;
	for (let round = 0; round < rounds; round++)
		checksum += privateTotal(round, 1, round & 7, 3);
	return checksum;
}

function driveExported() {
	const manual = counter.counts(3);
	const steps = [manual.next(), manual.next(10), manual.return(7), manual.next()];
	const thrown = counter.counts(2);
	thrown.next();
	let caught;
	try {
		thrown.throw(new Error("stop"));
	} catch (error) {
		caught = error.message;
	}
	const spread = [...counter.counts(4)];
	const before = counter.sumCounts(5);
	const inherited = counter.counts.prototype.next;
	counter.counts.prototype.next = function () {
		const step = inherited.call(this);
		return step.done ? step : { value: step.value * 100, done: false };
	};
	const patched = counter.sumCounts(5);
	delete counter.counts.prototype.next;
	return { steps, caught, spread, before, patched, after: counter.sumCounts(5) };
}

console.log(
	JSON.stringify({
		sequences: sumSequences(2_000),
		rest: sumRest(2_000),
		privateSteps: counter.sumPrivateSteps(400),
		exported: driveExported(),
	}),
);
