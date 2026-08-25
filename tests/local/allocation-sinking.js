const vector = (x, y, z) => ({ x, y, z });
const add = (left, right) => vector(left.x + right.x, left.y + right.y, left.z + right.z);
const scale = (value, factor) =>
	vector(value.x * factor, value.y * factor, value.z * factor);

function exercise(count) {
	let checksum = 0;
	const retained = [];
	for (let index = 0; index < count; index++) {
		const first = vector(index % 101, (index * 3) % 103, (index * 7) % 107);
		const second = scale(first, 0.5);
		const result = add(first, second);
		checksum += result.x + result.y + result.z;
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
	return { checksum, retainedChecksum, retained: retained.length, identity };
}

console.log(JSON.stringify(exercise(8_192)));
