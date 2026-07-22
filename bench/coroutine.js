// Suspendable-frame benchmark: generator delegation, sent values, explicit
// return/finally cleanup, concurrent async calls, and both manual and for-await
// async-generator consumption. `arguments` keeps the separate suspendable
// argument buffer represented. Bounded and deterministic.

const MOD = 1000000007;

function* sequence(seed) {
	let value = arguments[0];
	try {
		const sent = yield (value * 33 + 1) % MOD;
		value = (value + (sent ?? 0) + 7) % MOD;
		yield (value * 17 + 3) % MOD;
		return (value + 19) % MOD;
	} finally {
		yield (value + 97) % MOD;
	}
}

function* delegatedSequence(seed) {
	const terminal = yield* sequence(seed);
	return (terminal + seed) % MOD;
}

function generatorWork(count) {
	let checksum = 0;
	for (let i = 0; i < count; i++) {
		const iterator = delegatedSequence(i);
		let step = iterator.next();
		checksum = (checksum + step.value) % MOD;
		step = iterator.next(i & 7);
		checksum = (checksum + step.value) % MOD;
		if ((i & 3) === 0) {
			step = iterator.return(i + 11);
			checksum = (checksum + step.value) % MOD;
			step = iterator.next();
		} else {
			step = iterator.next();
			checksum = (checksum + step.value) % MOD;
			step = iterator.next();
		}
		checksum = (checksum + step.value) % MOD;
	}
	return checksum;
}

async function asyncStep(seed) {
	let value = seed;
	for (let i = 0; i < 3; i++) value = (value + (await ((seed + i) & 15))) % MOD;
	return value;
}

async function asyncBatch(count) {
	const pending = [];
	for (let i = 0; i < count; i++) pending.push(asyncStep(i));
	const values = await Promise.all(pending);
	let checksum = 0;
	for (let i = 0; i < values.length; i++) checksum = (checksum + values[i]) % MOD;
	return checksum;
}

async function* asyncSequence(seed) {
	try {
		const sent = yield seed + 1;
		yield (await Promise.resolve(seed + 2)) + (sent ?? 0);
		return seed + 3;
	} finally {
		yield seed + 5;
	}
}

async function manualAsyncGeneratorWork(count) {
	let checksum = 0;
	for (let i = 0; i < count; i++) {
		const iterator = asyncSequence(i);
		let step = await iterator.next();
		checksum = (checksum + step.value) % MOD;
		step = await iterator.next(i & 3);
		checksum = (checksum + step.value) % MOD;
		step = (i & 3) === 0 ? await iterator.return(i + 7) : await iterator.next();
		checksum = (checksum + step.value) % MOD;
		step = await iterator.next();
		checksum = (checksum + step.value) % MOD;
	}
	return checksum;
}

async function asyncIterationWork(count) {
	let checksum = 0;
	for (let i = 0; i < count; i++) {
		for await (const value of asyncSequence(i)) checksum = (checksum + value) % MOD;
	}
	return checksum;
}

const generatorChecksum = generatorWork(280000);
Promise.all([
	asyncBatch(43000),
	manualAsyncGeneratorWork(13000),
	asyncIterationWork(7500),
]).then((values) => {
	const checksum = (generatorChecksum + values[0] + values[1] + values[2]) % MOD;
	const EXPECTED_CHECKSUM = 28854625;
	if (checksum !== EXPECTED_CHECKSUM) {
		throw new Error("coroutine checksum " + checksum + " expected " + EXPECTED_CHECKSUM);
	}
	console.log(checksum);
});
