const vector = (x, y, z) => ({ x, y, z });
const add = (left, right) => vector(left.x + right.x, left.y + right.y, left.z + right.z);
const scale = (value, factor) =>
	vector(value.x * factor, value.y * factor, value.z * factor);
const dot = (left, right) => left.x * right.x + left.y * right.y + left.z * right.z;

function exercise(count) {
	let checksum = 0;
	const retained = [];
	const progress = { index: 0 };
	for (let index = 0; index < count; index++) {
		progress.index = index;
		const first = vector(index % 101, (index * 3) % 103, (index * 7) % 107);
		const second = scale(first, 0.5);
		const result = add(first, second);
		checksum += Math.round(dot(result, second));
		if ((index & 255) === 0) retained.push({ index, result });
	}

	let identity = 0;
	let retainedChecksum = 0;
	for (let index = 0; index < retained.length; index++) {
		const entry = retained[index];
		identity += index === 0 || entry.result !== retained[index - 1].result ? 1 : 0;
		entry.result.x += index;
		retainedChecksum += entry.index + entry.result.x + entry.result.y + entry.result.z;
	}
	return {
		checksum,
		retainedChecksum,
		retained: retained.length,
		identity,
		bounds: [0, count],
		progress,
	};
}

function sharedAcrossLoop(count) {
	const shared = { value: 3 };
	const copies = [];
	for (let index = 0; index < count; index++) copies.push(shared);
	copies[0].value = 11;
	let matches = 0;
	for (const value of copies) {
		if (value === copies[0] && value.value === 11) matches++;
	}
	return matches;
}

function nestedRetainedObjects(count) {
	let checksum = 0;
	const retained = [];
	for (let index = 0; index < count; index++) {
		const payload = { value: index + 1 };
		const wrapper = { payload };
		checksum += wrapper.payload.value;
		if ((index & 127) === 0) retained.push(wrapper);
	}
	let retainedChecksum = 0;
	for (let index = 0; index < retained.length; index++) {
		retained[index].payload.value += index;
		retainedChecksum += retained[index].payload.value;
	}
	return { checksum, retainedChecksum };
}

console.log(
	JSON.stringify({
		vectors: exercise(8_192),
		sharedAcrossLoop: sharedAcrossLoop(64),
		nested: nestedRetainedObjects(2_048),
	}),
);
