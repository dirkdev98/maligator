// Broad suspendable-frame benchmark: immediate generator churn, concurrent async
// calls, and sequential async-generator consumption. The generator reads
// `arguments` so the interpreter's separate suspendable argument buffer is also
// represented. Bounded and deterministic; prints one checksum shared with V8.

function* sequence(seed) {
	let value = arguments[0];
	for (let i = 0; i < 4; i++) {
		value = (value * 33 + i) % 1000000007;
		yield value;
	}
}

function generatorWork(count) {
	let checksum = 0;
	for (let i = 0; i < count; i++) {
		for (const value of sequence(i)) checksum = (checksum + value) % 1000000007;
	}
	return checksum;
}

async function asyncStep(seed) {
	let value = seed;
	for (let i = 0; i < 3; i++) value = (value + (await ((seed + i) & 15))) % 1000000007;
	return value;
}

async function asyncBatch(count) {
	const pending = [];
	for (let i = 0; i < count; i++) pending.push(asyncStep(i));
	const values = await Promise.all(pending);
	let checksum = 0;
	for (let i = 0; i < values.length; i++) checksum = (checksum + values[i]) % 1000000007;
	return checksum;
}

async function* asyncSequence(seed) {
	yield seed + 1;
	yield await Promise.resolve(seed + 2);
}

async function asyncGeneratorWork(count) {
	let checksum = 0;
	for (let i = 0; i < count; i++) {
		const iterator = asyncSequence(i);
		checksum = (checksum + (await iterator.next()).value) % 1000000007;
		checksum = (checksum + (await iterator.next()).value) % 1000000007;
		await iterator.next();
	}
	return checksum;
}

const generatorChecksum = generatorWork(20000);
Promise.all([asyncBatch(3000), asyncGeneratorWork(1000)]).then((values) => {
	console.log((generatorChecksum + values[0] + values[1]) % 1000000007);
});
