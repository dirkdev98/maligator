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
			typeof ReadableStreamDefaultReader === "function" &&
			typeof CountQueuingStrategy === "function" &&
			typeof ByteLengthQueuingStrategy === "function",
	);
	const countStrategy = new CountQueuingStrategy({ highWaterMark: 4 });
	const secondCountStrategy = new CountQueuingStrategy({ highWaterMark: 8 });
	const byteLengthStrategy = new ByteLengthQueuingStrategy({ highWaterMark: 16 });
	const countHighWaterMark = Object.getOwnPropertyDescriptor(
		CountQueuingStrategy.prototype,
		"highWaterMark",
	).get;
	const countSize = Object.getOwnPropertyDescriptor(
		CountQueuingStrategy.prototype,
		"size",
	).get;
	let crossBrandRejected = false;
	try {
		countHighWaterMark.call(byteLengthStrategy);
	} catch (error) {
		crossBrandRejected = error instanceof TypeError;
	}
	try {
		countSize.call(byteLengthStrategy);
		crossBrandRejected = false;
	} catch (error) {
		crossBrandRejected = crossBrandRejected && error instanceof TypeError;
	}
	check(
		"queuing strategy state and shared size algorithms",
		countStrategy.highWaterMark === 4 &&
			countStrategy.size === secondCountStrategy.size &&
			countStrategy.size({
				get byteLength() {
					throw new Error("ignored");
				},
			}) === 1 &&
			byteLengthStrategy.highWaterMark === 16 &&
			crossBrandRejected &&
			Object.prototype.propertyIsEnumerable.call(
				CountQueuingStrategy.prototype,
				"size",
			) &&
			byteLengthStrategy.size({ byteLength: 7 }) === 7,
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
	let modeToStringCalled = false;
	let invalidModeRejected = false;
	try {
		new ReadableStream().getReader({
			mode: {
				toString() {
					modeToStringCalled = true;
					return "";
				},
			},
		});
	} catch (error) {
		invalidModeRejected = error instanceof TypeError;
	}
	check(
		"reader mode uses Web IDL enum conversion",
		modeToStringCalled && invalidModeRejected,
	);

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
	const lockRead = firstReader.read().then(
		() => false,
		(error) => error instanceof TypeError,
	);
	firstReader.releaseLock();
	const releasedClosed = firstReader.closed.then(
		() => false,
		(error) => error instanceof TypeError,
	);
	lockController.enqueue("unlock");
	const releasedRead = firstReader.read().then(
		() => false,
		(error) => error instanceof TypeError,
	);
	check(
		"pending reads reject when a reader releases",
		doubleLock && (await lockRead) && !lockStream.locked,
	);
	check("released reader rejects", (await releasedClosed) && (await releasedRead));
	const secondReader = lockStream.getReader();
	const secondReaderValue = await secondReader.read();
	const secondClosed = secondReader.closed.catch(() => undefined);
	secondReader.releaseLock();
	await secondClosed;
	check(
		"stream can be relocked after a pending release",
		secondReaderValue.value === "unlock" && !lockStream.locked,
	);

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

	const sharedChunk = { marker: 42 };
	const publicTeeSource = new ReadableStream({
		start(controller) {
			controller.enqueue(sharedChunk);
			controller.enqueue("tail");
			controller.close();
		},
	});
	const publicBranches = publicTeeSource.tee();
	const publicReader1 = publicBranches[0].getReader();
	const publicReader2 = publicBranches[1].getReader();
	const [publicFirst1, publicFirst2] = await Promise.all([
		publicReader1.read(),
		publicReader2.read(),
	]);
	const [publicTail1, publicTail2] = await Promise.all([
		publicReader1.read(),
		publicReader2.read(),
	]);
	const [publicDone1, publicDone2] = await Promise.all([
		publicReader1.read(),
		publicReader2.read(),
	]);
	check(
		"public tee fans out ordered chunks",
		Array.isArray(publicBranches) &&
			publicBranches.length === 2 &&
			publicBranches[0] instanceof ReadableStream &&
			publicBranches[1] instanceof ReadableStream &&
			publicTeeSource.locked &&
			publicFirst1.value === sharedChunk &&
			publicFirst2.value === sharedChunk &&
			publicTail1.value === "tail" &&
			publicTail2.value === "tail" &&
			publicDone1.done &&
			publicDone2.done,
	);
	const lockedTeeSource = new ReadableStream();
	lockedTeeSource.getReader();
	let lockedTeeThrows = false;
	try {
		lockedTeeSource.tee();
	} catch (error) {
		lockedTeeThrows = error instanceof TypeError;
	}
	check("public tee rejects locked sources", lockedTeeThrows);

	let publicCancelReasons;
	const publicCancelSource = new ReadableStream({
		cancel(reasons) {
			publicCancelReasons = reasons;
		},
	});
	const [publicCancelBranch1, publicCancelBranch2] = publicCancelSource.tee();
	const publicCancel1 = publicCancelBranch1.cancel("left");
	let publicCancel1Settled = false;
	publicCancel1.then(() => {
		publicCancel1Settled = true;
	});
	await tick();
	const publicCancel1StayedPending = !publicCancel1Settled;
	const publicCancel2 = publicCancelBranch2.cancel("right");
	await Promise.all([publicCancel1, publicCancel2]);
	check(
		"public tee combines cancellation reasons",
		publicCancel1StayedPending &&
			publicCancelReasons[0] === "left" &&
			publicCancelReasons[1] === "right",
	);

	const publicCancelError = { marker: "cancel failed" };
	const publicCancelErrorSource = new ReadableStream({
		cancel() {
			throw publicCancelError;
		},
	});
	const [publicCancelErrorBranch1, publicCancelErrorBranch2] =
		publicCancelErrorSource.tee();
	const publicCancelError1 = publicCancelErrorBranch1.cancel();
	await tick();
	const publicCancelError2 = publicCancelErrorBranch2.cancel();
	const publicCancelErrors = await Promise.all([
		publicCancelError1.then(
			() => false,
			(error) => error === publicCancelError,
		),
		publicCancelError2.then(
			() => false,
			(error) => error === publicCancelError,
		),
	]);
	check(
		"public tee propagates cancellation errors",
		publicCancelErrors[0] && publicCancelErrors[1],
	);

	let publicTeeErrorController;
	const publicTeeError = { marker: "source failed" };
	const publicTeeErrorSource = new ReadableStream({
		start(controller) {
			publicTeeErrorController = controller;
		},
	});
	const [publicTeeErrorBranch1, publicTeeErrorBranch2] = publicTeeErrorSource.tee();
	const publicTeeErrorReader1 = publicTeeErrorBranch1.getReader();
	const publicTeeErrorReader2 = publicTeeErrorBranch2.getReader();
	publicTeeErrorController.enqueue("queued");
	await Promise.all([publicTeeErrorReader1.read(), publicTeeErrorReader2.read()]);
	publicTeeErrorController.error(publicTeeError);
	const publicTeeClosedErrors = await Promise.all([
		publicTeeErrorReader1.closed.then(
			() => false,
			(error) => error === publicTeeError,
		),
		publicTeeErrorReader2.closed.then(
			() => false,
			(error) => error === publicTeeError,
		),
	]);
	check(
		"public tee observes source errors without pending reads",
		publicTeeClosedErrors[0] && publicTeeClosedErrors[1],
	);

	const publicTeePullError = { marker: "pull failed" };
	const publicTeePullErrorSource = new ReadableStream({
		start(controller) {
			controller.enqueue("first");
			controller.enqueue("second");
		},
		pull() {
			throw publicTeePullError;
		},
	});
	const [publicTeePullErrorBranch1, publicTeePullErrorBranch2] =
		publicTeePullErrorSource.tee();
	const publicTeePullErrorReader1 = publicTeePullErrorBranch1.getReader();
	const publicTeePullErrorReader2 = publicTeePullErrorBranch2.getReader();
	const publicTeePullFirst = await publicTeePullErrorReader1.read();
	const publicTeePullSecond = await publicTeePullErrorReader1.read();
	const publicTeePullRejected = await Promise.all([
		publicTeePullErrorReader1.read().then(
			() => false,
			(error) => error === publicTeePullError,
		),
		publicTeePullErrorReader1.closed.then(
			() => false,
			(error) => error === publicTeePullError,
		),
		publicTeePullErrorReader2.closed.then(
			() => false,
			(error) => error === publicTeePullError,
		),
	]);
	check(
		"public tee drains chunks before a pull error",
		publicTeePullFirst.value === "first" &&
			publicTeePullSecond.value === "second" &&
			publicTeePullRejected[0] &&
			publicTeePullRejected[1] &&
			publicTeePullRejected[2],
	);
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
