function makeRecord(id, value) {
	return { id, data: { value, previous: value - 1 }, read: () => value + id };
}

function retainedGraphs(count) {
	const retained = [];
	let checksum = 0;
	for (let index = 0; index < count; index++) {
		const record = makeRecord(index & 31, index * 2);
		checksum += record.read();
		if ((index & 7) === 0) retained[index >> 3] = record;
	}
	let identities = 0;
	for (let index = 0; index < retained.length; index++) {
		const record = retained[index];
		identities += index === 0 || record !== retained[index - 1] ? 1 : 0;
		record.data.value += index;
		checksum += record.read() + record.data.previous + record.data.value;
	}
	return { checksum, identities, names: retained.map((record) => record.read.name) };
}

function consumeGraphs(count) {
	let checksum = 0;
	for (let index = 0; index < count; index++) {
		const record = makeRecord(index, index + 1);
		checksum += record.read();
	}
	return checksum;
}

function mutableFactory(id, value) {
	const result = { read: () => ++value + id };
	value += 3;
	return result;
}

function fallbackCases() {
	const retained = [];
	const events = [];
	let checksum = 0;
	for (let index = 0; index < 24; index++) {
		const record = mutableFactory(index, index);
		checksum += record.read();
		if ((index & 3) === 0) retained[index >> 2] = record;
	}
	for (const record of retained) checksum += record.read();
	for (let index = 0; index < 12; index++) {
		const record = makeRecord(index, {
			valueOf() {
				events.push(index);
				return index;
			},
		});
		checksum += record.read();
		if ((index & 3) === 0) retained[index >> 2] = record;
	}
	return { checksum, events };
}

function repeatedIdentity(count) {
	const retained = [];
	let checksum = 0;
	for (let index = 0; index < count; index++) {
		const record = makeRecord(index, index);
		checksum += record.read();
		for (let inner = 0; inner < 4; inner++) retained.push(record);
	}
	return {
		checksum,
		same: retained[0] === retained[3],
		distinct: retained[0] !== retained[4],
	};
}

console.log(
	JSON.stringify({
		retained: retainedGraphs(256),
		consumed: consumeGraphs(1_024),
		fallbacks: fallbackCases(),
		repeated: repeatedIdentity(16),
	}),
);
