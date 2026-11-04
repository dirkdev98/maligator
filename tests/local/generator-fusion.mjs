function* sequence(seed) {
	for (let index = 0; index < 12; index++) yield (seed + index * 3) & 255;
	return 999;
}

function traversal() {
	let checksum = 0;
	for (let round = 0; round < 16; round++) {
		for (const value of sequence(round)) checksum += value;
		for (const value of sequence(round)) {
			if (value & 1) continue;
			checksum += value;
			if (value > 9) break;
		}
	}
	return checksum;
}

function* sentSequence(seed) {
	for (let index = 0; index < 4; index++) {
		const sent = yield seed + index;
		if (sent !== undefined) throw 123;
	}
}

function sentValues() {
	let checksum = 0;
	for (let round = 0; round < 8; round++) {
		for (const value of sentSequence(round)) checksum += value;
	}
	return checksum;
}

function* throwingSequence(seed) {
	for (let index = 0; index < 5; index++) {
		if (index === 3) throw seed + index;
		yield seed + index;
	}
}

function exceptions() {
	let checksum = 0;
	const caught = [];
	for (let round = 0; round < 4; round++) {
		try {
			for (const value of throwingSequence(round)) checksum += value;
		} catch (error) {
			caught.push(error);
		}
	}
	return { checksum, caught };
}

function consumerExceptions() {
	let checksum = 0;
	const caught = [];
	for (let round = 0; round < 4; round++) {
		try {
			for (const value of sequence(round)) {
				if (value > 6) throw value;
				checksum += value;
			}
		} catch (error) {
			caught.push(error);
		}
	}
	return { checksum, caught };
}

function consumerAllocation() {
	const retained = [];
	for (let round = 0; round < 16; round++) {
		for (const value of sequence(round)) retained.push({ value, label: String(value) });
	}
	return retained.map((entry) => entry.value).join(",");
}

function* specialSequence(seed) {
	for (let index = 0; index < 3; index++) yield seed / (index + 1);
}

function specialNumbers() {
	const result = [];
	for (const value of specialSequence(-0)) result.push(Object.is(value, -0));
	for (const value of specialSequence(NaN)) result.push(Number.isNaN(value));
	for (const value of specialSequence(Infinity)) result.push(value === Infinity);
	for (const value of specialSequence(-Infinity)) result.push(value === -Infinity);
	return result;
}

function* initializedSequence(seed) {
	if (seed < 0) return;
	const step = seed + 2;
	for (let index = 0; index < 3; index++) yield step + index;
}

function earlyCompletion() {
	let checksum = 0;
	for (let round = -2; round < 3; round++) {
		for (const value of initializedSequence(round)) checksum += value;
	}
	return checksum;
}

function* observedSequence(seed) {
	for (let index = 0; index < 3; index++) yield seed + index;
}

function prototypeObservation() {
	const prototype = Object.getPrototypeOf(observedSequence(0));
	prototype.next = () => ({ value: 71, done: true });
	let checksum = 0;
	for (const value of observedSequence(1)) checksum += value;
	return checksum;
}

const cleanup = [];
function* cleanupSequence(seed) {
	try {
		for (let index = 0; index < 3; index++) yield seed + index;
	} finally {
		cleanup.push(seed);
	}
}

function closing() {
	let checksum = 0;
	for (let round = 0; round < 3; round++) {
		for (const value of cleanupSequence(round)) {
			checksum += value;
			break;
		}
	}
	return { checksum, cleanup };
}

function* coercingSequence(seed) {
	for (let index = 0; index < 3; index++) yield seed + index;
}

function coercion() {
	const events = [];
	let checksum = 0;
	for (const value of coercingSequence({
		valueOf() {
			events.push("coerce");
			return 5;
		},
	}))
		checksum += value;
	return { checksum, events };
}

console.log(
	JSON.stringify({
		traversal: traversal(),
		sentValues: sentValues(),
		exceptions: exceptions(),
		consumerExceptions: consumerExceptions(),
		consumerAllocation: consumerAllocation(),
		specialNumbers: specialNumbers(),
		earlyCompletion: earlyCompletion(),
		prototypeObservation: prototypeObservation(),
		closing: closing(),
		coercion: coercion(),
	}),
);
