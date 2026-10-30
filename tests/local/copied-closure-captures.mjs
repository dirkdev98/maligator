function immutableFactory(id, payload) {
	const padding = Array.from({ length: 12 }, (_, index) => ({ index }));
	return {
		read: () => id + payload.value,
		payload: () => payload,
		padding: padding.length,
	};
}

function mutableFactory(value) {
	return {
		read: () => ++value,
		set: (next) => {
			value = next;
		},
	};
}

function mixedFactory(id, mutable) {
	const fixed = () => id;
	let state = id;
	if (mutable) return { fixed, read: () => ++state };
	return { fixed, read: fixed };
}

function uninitializedFactory() {
	const read = () => later;
	let before;
	try {
		read();
	} catch (error) {
		before = error.name;
	}
	let later = { value: 17 };
	return { before, read };
}

const scenario = process.env.COPIED_CAPTURE_CASE;
const results = [];
if (scenario === "retained") {
	const readers = [];
	for (let index = 0; index < 80; index++) {
		const payload = { value: index };
		const record = immutableFactory(index, payload);
		payload.value += 7;
		readers.push(record);
	}
	for (const record of readers)
		results.push(record.read(), record.payload().value, record.padding);
} else if (scenario === "mutable") {
	const record = mutableFactory(3);
	results.push(record.read());
	record.set(20);
	results.push(record.read(), record.read());
} else if (scenario === "mixed") {
	for (const flag of [false, true]) {
		const record = mixedFactory(11, flag);
		results.push(record.fixed(), record.read(), record.read(), record.fixed());
	}
} else if (scenario === "uninitialized") {
	const record = uninitializedFactory();
	results.push(record.before, record.read().value);
} else throw new Error(`unknown scenario ${scenario}`);
console.log(JSON.stringify(results));
