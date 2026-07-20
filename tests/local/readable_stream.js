const results = [];

function check(name, condition) {
	results.push([name, !!condition]);
}

function tick() {
	return Promise.resolve().then(() => Promise.resolve());
}

async function run() {
	check(
		"globals",
		typeof ReadableStream === "function" &&
			typeof ReadableStreamDefaultController === "function" &&
			typeof ReadableStreamDefaultReader === "function",
	);

	let queuedController;
	const queued = new ReadableStream({
		start(controller) {
			queuedController = controller;
			controller.enqueue("first");
			controller.enqueue("second");
			controller.close();
		},
	});
	check("controller brand", queuedController instanceof ReadableStreamDefaultController);
	check("queued desiredSize", queuedController.desiredSize === -1);
	const queuedReader = queued.getReader();
	check(
		"reader brand and lock",
		queuedReader instanceof ReadableStreamDefaultReader && queued.locked,
	);
	const q1 = await queuedReader.read();
	const q2 = await queuedReader.read();
	const q3 = await queuedReader.read();
	await queuedReader.closed;
	check(
		"enqueue before read FIFO",
		q1.value === "first" && !q1.done && q2.value === "second" && !q2.done,
	);
	check(
		"close after queued chunks",
		q3.done && q3.value === undefined && queuedController.desiredSize === 0,
	);

	let pendingController;
	const pendingStream = new ReadableStream({
		start(controller) {
			pendingController = controller;
		},
	});
	const pendingReader = pendingStream.getReader();
	const pendingRead = pendingReader.read();
	pendingController.enqueue({ marker: 17 });
	const pendingValue = await pendingRead;
	check("pending read settled", pendingValue.value.marker === 17 && !pendingValue.done);
	pendingController.close();
	check("pending reader closed", (await pendingReader.closed) === undefined);

	const boom = { boom: true };
	let errorController;
	const errored = new ReadableStream({
		start(controller) {
			errorController = controller;
		},
	});
	const errorReader = errored.getReader();
	const rejectedRead = errorReader.read().then(
		() => false,
		(reason) => reason === boom,
	);
	const rejectedClosed = errorReader.closed.then(
		() => false,
		(reason) => reason === boom,
	);
	errorController.error(boom);
	errorController.error({ ignored: true });
	check(
		"error rejects read and closed once",
		(await rejectedRead) && (await rejectedClosed),
	);
	let invalidSizeController;
	const invalidSizeStream = new ReadableStream(
		{
			start(controller) {
				invalidSizeController = controller;
			},
		},
		{ highWaterMark: 1, size: () => NaN },
	);
	let invalidSizeError;
	try {
		invalidSizeController.enqueue("invalid");
	} catch (error) {
		invalidSizeError = error;
	}
	const invalidSizeRejection = await invalidSizeStream
		.getReader()
		.closed.catch((error) => error);
	check(
		"invalid strategy size throws and errors with one RangeError",
		invalidSizeError instanceof RangeError && invalidSizeRejection === invalidSizeError,
	);
	const invalidSizeIdentities = [];
	for (const size of [NaN, -Infinity, Infinity, -1]) {
		let thrown;
		let controller;
		const stream = new ReadableStream(
			{
				start(value) {
					controller = value;
				},
			},
			{ highWaterMark: 1, size: () => size },
		);
		try {
			controller.enqueue("invalid");
		} catch (error) {
			thrown = error;
		}
		invalidSizeIdentities.push(
			stream.getReader().closed.catch((error) => error === thrown),
		);
	}
	check(
		"invalid strategy size identity survives loop closures",
		(await Promise.all(invalidSizeIdentities)).every(Boolean),
	);
	let enqueueAfterError = false;
	try {
		errorController.enqueue("late");
	} catch (error) {
		enqueueAfterError = error instanceof TypeError;
	}
	check(
		"enqueue after error throws",
		enqueueAfterError && errorController.desiredSize === null,
	);

	let cancelReason;
	const cancellable = new ReadableStream({
		cancel(reason) {
			cancelReason = reason;
			return Promise.resolve("ignored");
		},
	});
	const cancelReader = cancellable.getReader();
	const canceledRead = cancelReader.read();
	const cancelResult = await cancelReader.cancel("stop");
	const canceledValue = await canceledRead;
	check(
		"cancel algorithm and settlement",
		cancelReason === "stop" && cancelResult === undefined && canceledValue.done,
	);
	check("cancel closes reader", (await cancelReader.closed) === undefined);
	const lockedCancel = cancellable.cancel().then(
		() => false,
		(error) => error instanceof TypeError,
	);
	check("locked stream cancel rejects", await lockedCancel);

	let pullCount = 0;
	let resolveFirstPull;
	let pullController;
	const pulled = new ReadableStream(
		{
			pull(controller) {
				pullCount++;
				pullController = controller;
				if (pullCount === 1) {
					controller.enqueue("one");
					return new Promise((resolve) => {
						resolveFirstPull = resolve;
					});
				}
				controller.enqueue("two");
				return Promise.resolve();
			},
		},
		{ highWaterMark: 1 },
	);
	await tick();
	check(
		"initial pull obeys backpressure",
		pullCount === 1 && pullController.desiredSize === 0,
	);
	const pullReader = pulled.getReader();
	const firstPullValue = await pullReader.read();
	check(
		"pull not reentrant while pending",
		firstPullValue.value === "one" && pullCount === 1,
	);
	resolveFirstPull();
	await tick();
	check(
		"consumer demand resumes pull",
		pullCount === 2 && pullController.desiredSize === 0,
	);
	const secondPullValue = await pullReader.read();
	check("promise-returning pull", secondPullValue.value === "two");
	await pullReader.cancel();

	let lockController;
	const lockStream = new ReadableStream({
		start(controller) {
			lockController = controller;
		},
	});
	const firstReader = new ReadableStreamDefaultReader(lockStream);
	let doubleLock = false;
	try {
		lockStream.getReader();
	} catch (error) {
		doubleLock = error instanceof TypeError;
	}
	const lockRead = firstReader.read();
	let pendingRelease = false;
	try {
		firstReader.releaseLock();
	} catch (error) {
		pendingRelease = error instanceof TypeError;
	}
	lockController.enqueue("unlock");
	await lockRead;
	const releasedClosed = firstReader.closed.then(
		() => false,
		(error) => error instanceof TypeError,
	);
	firstReader.releaseLock();
	const releasedRead = firstReader.read().then(
		() => false,
		(error) => error instanceof TypeError,
	);
	check(
		"locking and pending release error",
		doubleLock && pendingRelease && !lockStream.locked,
	);
	check("released reader rejects", (await releasedClosed) && (await releasedRead));
	const secondReader = lockStream.getReader();
	const secondClosed = secondReader.closed.catch(() => undefined);
	secondReader.releaseLock();
	await secondClosed;
	check("stream can be relocked", !lockStream.locked);

	let closedReleaseController;
	const closedReleaseStream = new ReadableStream({
		start(controller) {
			closedReleaseController = controller;
		},
	});
	const closedReleaseReader = closedReleaseStream.getReader();
	closedReleaseController.close();
	await closedReleaseReader.closed;
	closedReleaseReader.releaseLock();
	check(
		"released closed reader gets release error",
		await closedReleaseReader.closed.then(
			() => false,
			(error) => error instanceof TypeError,
		),
	);

	let started = false;
	const asyncStart = new ReadableStream({
		start(controller) {
			return Promise.resolve().then(() => {
				started = true;
				controller.enqueue("started");
				controller.close();
			});
		},
	});
	const asyncStartValue = await asyncStart.getReader().read();
	check("promise-returning start", started && asyncStartValue.value === "started");
	const startError = { start: true };
	let synchronousStartError = false;
	try {
		new ReadableStream({
			start() {
				throw startError;
			},
		});
	} catch (error) {
		synchronousStartError = error === startError;
	}
	check("synchronous start throw", synchronousStartError);

	const rejectedStartError = { rejectedStart: true };
	const rejectedStartReader = new ReadableStream({
		start() {
			return Promise.reject(rejectedStartError);
		},
	}).getReader();
	const rejectedStartClosed = rejectedStartReader.closed.then(
		() => false,
		(error) => error === rejectedStartError,
	);
	const rejectedStartRead = rejectedStartReader.read().then(
		() => false,
		(error) => error === rejectedStartError,
	);
	check(
		"promise-rejected start errors stream",
		(await rejectedStartClosed) && (await rejectedStartRead),
	);

	const rejectedPullError = { rejectedPull: true };
	const rejectedPullReader = new ReadableStream({
		pull() {
			return Promise.reject(rejectedPullError);
		},
	}).getReader();
	const rejectedPullClosed = rejectedPullReader.closed.then(
		() => false,
		(error) => error === rejectedPullError,
	);
	const rejectedPullRead = rejectedPullReader.read().then(
		() => false,
		(error) => error === rejectedPullError,
	);
	check(
		"promise-rejected pull errors stream",
		(await rejectedPullClosed) && (await rejectedPullRead),
	);

	let closeController;
	new ReadableStream({
		start(controller) {
			closeController = controller;
		},
	});
	closeController.close();
	let secondClose = false;
	try {
		closeController.close();
	} catch (error) {
		secondClose = error instanceof TypeError;
	}
	check("close is one-shot", secondClose);
}

run().then(
	() => {
		let passed = 0;
		for (const result of results) {
			if (result[1]) passed++;
			else console.log("FAIL: " + result[0]);
		}
		console.log("RESULT " + passed + "/" + results.length);
	},
	(error) => {
		console.log("FAIL: unexpected " + error);
		console.log("RESULT 0/1");
	},
);
