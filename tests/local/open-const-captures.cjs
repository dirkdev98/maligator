function immutableFactory(id, payload) {
	const number = id;
	const record = payload;
	return { read: () => number + record.value, payload: () => record };
}

function mixedFactory(payload, share) {
	const record = payload;
	const read = () => record;
	let state = 3;
	if (share) return { read, next: () => ++state };
	return { read, next: () => 0 };
}

function mutableFactory(value) {
	return { read: () => value, set: (next) => (value = next) };
}

function uninitializedFactory() {
	const read = () => later;
	let before;
	try {
		read();
	} catch (error) {
		before = error.name;
	}
	const later = { value: 17 };
	return { before, read };
}

function evaluatedFactory(payload) {
	const fixed = payload;
	let value = 1;
	const read = () => fixed;
	eval("value = 9");
	let rejected = false;
	try {
		eval("fixed = null");
	} catch (error) {
		rejected = error instanceof TypeError;
	}
	return { read, value, rejected };
}

function dynamicOther(box) {
	with (box) {
		return value;
	}
}

function withFactory(box) {
	with (box) {
		return () => value;
	}
}

function initializedByCallback(make) {
	const value = make();
	return () => value;
}

const scenario = process.env.OPEN_CAPTURE_CASE;
const results = [dynamicOther({ value: 42 })];
if (scenario === "retained") {
	const readers = [];
	for (let index = 0; index < 80; index++) {
		const payload = { value: index };
		const record = immutableFactory(index, payload);
		payload.value += 7;
		readers.push(record);
	}
	for (const record of readers) results.push(record.read(), record.payload().value);
} else if (scenario === "mixed") {
	for (const share of [false, true]) {
		const payload = { value: 11 };
		const record = mixedFactory(payload, share);
		payload.value++;
		results.push(
			record.read() === payload,
			record.next(),
			record.next(),
			record.read().value,
		);
	}
} else if (scenario === "mutable") {
	const record = mutableFactory(3);
	results.push(record.read());
	record.set(20);
	results.push(record.read());
} else if (scenario === "uninitialized") {
	const record = uninitializedFactory();
	results.push(record.before, record.read().value);
} else if (scenario === "eval") {
	const payload = { value: 7 };
	const record = evaluatedFactory(payload);
	results.push(record.read() === payload, record.value, record.rejected);
} else if (scenario === "with") {
	const box = { value: 3 };
	const read = withFactory(box);
	results.push(read());
	box.value = 20;
	results.push(read());
} else if (scenario === "loop") {
	const readers = [];
	for (let index = 0; index < 4; index++) {
		const value = { index };
		readers.push(() => value);
	}
	for (const read of readers) results.push(read().index);
	results.push(readers[0]() !== readers[1]());
} else if (scenario === "initialization") {
	const payload = { value: 5 };
	const read = initializedByCallback(() => payload);
	results.push(read() === payload);
	const marker = {};
	try {
		initializedByCallback(() => {
			throw marker;
		});
	} catch (error) {
		results.push(error === marker);
	}
} else if (scenario === "self") {
	const factory = function self() {
		const read = () => self;
		self = null;
		return read;
	};
	results.push(factory()() === factory);
} else throw new Error(`unknown scenario ${scenario}`);
console.log(JSON.stringify(results));
