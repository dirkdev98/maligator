const POOL_LIMIT = 4096;
const REQUEST_COUNT = POOL_LIMIT + 17;

function queueBatch(count) {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	async function* values() {
		await gate;
		for (let i = 0; i < count; i++) yield i;
		return count;
	}

	const iterator = values();
	let first;
	let boundary;
	let completed;
	for (let i = 0; i <= count; i++) {
		const request = iterator.next();
		if (i === 0) first = request;
		if (i === POOL_LIMIT) boundary = request;
		if (i === count) completed = request;
	}
	release();
	return Promise.all([first, boundary, completed]);
}

queueBatch(REQUEST_COUNT)
	.then((overflow) =>
		queueBatch(REQUEST_COUNT).then((reused) => {
			if (
				overflow[0].value !== 0 ||
				overflow[0].done ||
				overflow[1].value !== POOL_LIMIT ||
				overflow[1].done ||
				overflow[2].value !== REQUEST_COUNT ||
				!overflow[2].done ||
				reused[0].value !== 0 ||
				reused[0].done ||
				reused[1].value !== POOL_LIMIT ||
				reused[1].done ||
				reused[2].value !== REQUEST_COUNT ||
				!reused[2].done
			) {
				throw new Error("async-generator request pool overflow mismatch");
			}
		}),
	)
	.then(() => console.log("async-generator-request-pool-overflow PASS"));
