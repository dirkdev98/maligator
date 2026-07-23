// Promise/microtask orchestration benchmark: dependent transforms, pending
// fan-out, async/await, thenable assimilation, mixed batch settlement and
// recovery, all/race/allSettled, and finally cleanup. Bounded and deterministic.

const MOD = 1000000007;

function chainWork(count) {
	let promise = Promise.resolve(1);
	for (let i = 0; i < count; i++) {
		promise = promise.then((value) => (value * 33 + i) % MOD);
	}
	return promise;
}

function fanoutWork(count) {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const outputs = [];
	for (let i = 0; i < count; i++) {
		outputs.push(gate.then((value) => value + i));
	}
	const joined = Promise.all(outputs);
	release(17);
	return joined;
}

async function awaitWork(count) {
	let sum = 0;
	for (let i = 0; i < count; i++) {
		sum = (sum + (await (i & 7))) % MOD;
	}
	return sum;
}

async function batchWork(batchCount, width) {
	let checksum = 0;
	let finalized = 0;
	for (let batch = 0; batch < batchCount; batch++) {
		const pending = [];
		for (let i = 0; i < width; i++) {
			const value = batch * width + i;
			let promise;
			if (i % 7 === 0) {
				promise = Promise.resolve({
					then(resolve) {
						resolve(value + 3);
					},
				});
			} else if (i % 5 === 0) {
				promise = Promise.reject(value + 11);
			} else {
				promise = Promise.resolve(value).then((current) => (current * 17 + batch) % MOD);
			}
			pending.push(
				promise.finally(() => {
					finalized++;
				}),
			);
		}

		const settled = await Promise.allSettled(pending);
		for (let i = 0; i < settled.length; i++) {
			const result = settled[i];
			checksum =
				(checksum + (result.status === "fulfilled" ? result.value : result.reason * 3)) %
				MOD;
		}
		checksum =
			(checksum +
				(await Promise.race([
					Promise.resolve(batch + 13),
					Promise.resolve(batch + 29),
				]))) %
			MOD;
	}
	return (checksum + finalized * 19) % MOD;
}

async function asyncGeneratorWork(count) {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	async function* sequence() {
		await gate;
		for (let i = 0; i < count; i++) yield (i * 13 + 5) % MOD;
		return count;
	}

	const iterator = sequence();
	const pending = [];
	for (let i = 0; i <= count; i++) pending.push(iterator.next());
	release();
	const results = await Promise.all(pending);
	let checksum = 0;
	for (let i = 0; i < count; i++) {
		const result = results[i];
		if (result.done || result.value !== (i * 13 + 5) % MOD) {
			throw new Error("async generator result " + i);
		}
		checksum = (checksum + result.value) % MOD;
	}
	if (!results[count].done || results[count].value !== count) {
		throw new Error("async generator completion");
	}

	const returned = await sequence().return(71);
	if (!returned.done || returned.value !== 71) throw new Error("async generator return");
	try {
		await sequence().throw(73);
		throw new Error("async generator throw did not reject");
	} catch (reason) {
		if (reason !== 73) throw reason;
	}
	return (checksum + count + returned.value + 73) % MOD;
}

const thenable = {
	then(resolve) {
		resolve(12345);
	},
};

Promise.all([
	chainWork(120000),
	fanoutWork(42000),
	awaitWork(24000),
	batchWork(2400, 24),
	Promise.resolve(thenable),
	Promise.reject(99).catch((value) => value + 1),
	asyncGeneratorWork(48000),
]).then((values) => {
	let checksum = values[0] + values[2] + values[3] + values[4] + values[5] + values[6];
	for (let i = 0; i < values[1].length; i++) {
		checksum = (checksum + values[1][i]) % MOD;
	}
	const EXPECTED_CHECKSUM = 680787877;
	if (checksum !== EXPECTED_CHECKSUM) {
		throw new Error("promise checksum " + checksum + " expected " + EXPECTED_CHECKSUM);
	}
	console.log(checksum);
});
