const results = [];

function check(name, condition) {
	results.push([name, !!condition]);
}

function tick() {
	return Promise.resolve().then(() => Promise.resolve());
}

async function run() {
	let typeToStringCalls = 0;
	check(
		"null source rejected",
		(() => {
			try {
				new ReadableStream(null);
				return false;
			} catch (error) {
				return error instanceof TypeError;
			}
		})(),
	);
	check(
		"source type conversion",
		(() => {
			try {
				new ReadableStream({
					type: {
						toString() {
							typeToStringCalls++;
							return "invalid";
						},
					},
				});
				return false;
			} catch (error) {
				return error instanceof TypeError && typeToStringCalls === 1;
			}
		})(),
	);
	check(
		"globals",
		typeof ReadableStream === "function" &&
			typeof ReadableStreamDefaultController === "function" &&
			typeof ReadableByteStreamController === "function" &&
			typeof ReadableStreamDefaultReader === "function" &&
			typeof ReadableStreamBYOBReader === "function" &&
			typeof ReadableStreamBYOBRequest === "function" &&
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

	let byteController;
	const byteChunk = new Uint16Array([0x0201, 0x0403]);
	const byteStream = new ReadableStream({
		type: "bytes",
		start(controller) {
			byteController = controller;
			controller.enqueue(byteChunk);
			controller.close();
		},
	});
	const byteRead = await byteStream.getReader().read();
	check(
		"public byte source controller and default read",
		byteController instanceof ReadableByteStreamController &&
			!(byteController instanceof ReadableStreamDefaultController) &&
			byteController.byobRequest === null &&
			byteRead.value instanceof Uint8Array &&
			byteRead.value.byteLength === 4 &&
			byteRead.value[0] === 1 &&
			byteRead.value[1] === 2 &&
			byteChunk.byteLength === 0 &&
			byteController.desiredSize === 0,
	);

	let byteByobController;
	const byteByobStream = new ReadableStream({
		type: "bytes",
		start(controller) {
			byteByobController = controller;
			controller.enqueue(new Uint8Array([5, 6, 7]));
			controller.close();
		},
	});
	const byteByobReader = byteByobStream.getReader({ mode: "byob" });
	const byteByobFirst = await byteByobReader.read(new Uint8Array(2));
	const byteByobSecond = await byteByobReader.read(new Uint8Array(2));
	const byteByobDone = await byteByobReader.read(new Uint8Array(1));
	check(
		"public byte source supports queued BYOB reads",
		byteByobController.desiredSize === 0 &&
			byteByobFirst.value[0] === 5 &&
			byteByobFirst.value[1] === 6 &&
			byteByobSecond.value.byteLength === 1 &&
			byteByobSecond.value[0] === 7 &&
			byteByobDone.done &&
			byteByobDone.value.byteLength === 0,
	);

	let liveByobRequest;
	let liveByobController;
	const pullIntoStream = new ReadableStream({
		type: "bytes",
		pull(controller) {
			liveByobController = controller;
			liveByobRequest = controller.byobRequest;
			liveByobRequest.view[0] = 9;
			liveByobRequest.view[1] = 8;
			liveByobRequest.respond(2);
			controller.close();
		},
	});
	const pullIntoReader = pullIntoStream.getReader({ mode: "byob" });
	const pullInto = await pullIntoReader.read(new Uint16Array(2));
	check(
		"BYOB pull exposes and invalidates a live request",
		liveByobRequest instanceof ReadableStreamBYOBRequest &&
			liveByobRequest.view === null &&
			liveByobController.byobRequest === null &&
			pullInto.value instanceof Uint16Array &&
			pullInto.value.byteLength === 2 &&
			new Uint8Array(pullInto.value.buffer)[0] === 9 &&
			new Uint8Array(pullInto.value.buffer)[1] === 8,
	);
	let staleByobRequestRejected = false;
	try {
		liveByobRequest.respond(1);
	} catch (error) {
		staleByobRequestRejected = error instanceof TypeError;
	}
	check("consumed BYOB request rejects respond", staleByobRequestRejected);

	const replacementStream = new ReadableStream({
		type: "bytes",
		pull(controller) {
			const request = controller.byobRequest;
			request.view[0] = 7;
			request.view[1] = 6;
			request.respondWithNewView(request.view.subarray(0, 2));
			controller.close();
		},
	});
	const replacementRead = await replacementStream
		.getReader({ mode: "byob" })
		.read(new Uint8Array(4));
	check(
		"BYOB request accepts a replacement view over the pending region",
		replacementRead.value.byteLength === 2 &&
			replacementRead.value[0] === 7 &&
			replacementRead.value[1] === 6,
	);

	let autoAllocateRequest;
	const autoAllocateStream = new ReadableStream({
		type: "bytes",
		autoAllocateChunkSize: 4,
		pull(controller) {
			autoAllocateRequest = controller.byobRequest;
			autoAllocateRequest.view[0] = 3;
			autoAllocateRequest.view[1] = 4;
			autoAllocateRequest.respond(2);
			controller.close();
		},
	});
	const autoAllocateRead = await autoAllocateStream.getReader().read();
	check(
		"default byte reader exposes an auto-allocated BYOB request",
		autoAllocateRequest instanceof ReadableStreamBYOBRequest &&
			autoAllocateRequest.view === null &&
			autoAllocateRead.value instanceof Uint8Array &&
			autoAllocateRead.value.byteLength === 2 &&
			autoAllocateRead.value[0] === 3 &&
			autoAllocateRead.value[1] === 4,
	);
	let zeroAutoAllocateRejected = false;
	try {
		new ReadableStream({ type: "bytes", autoAllocateChunkSize: 0 });
	} catch (error) {
		zeroAutoAllocateRejected = error instanceof TypeError;
	}
	check("zero autoAllocateChunkSize is rejected", zeroAutoAllocateRejected);

	const invalidByobReader = new ReadableStream({ type: "bytes" }).getReader({
		mode: "byob",
	});
	let invalidByobReadRejected = false;
	try {
		const invalidByobRead = invalidByobReader.read();
		invalidByobReadRejected = await invalidByobRead.then(
			() => false,
			(error) => error instanceof TypeError,
		);
	} catch {
		invalidByobReadRejected = false;
	}
	check("invalid BYOB read views return rejected promises", invalidByobReadRejected);
	await invalidByobReader.cancel();

	let partialRespondPulls = 0;
	let partialRespondTransferred = true;
	const partialRespondStream = new ReadableStream({
		type: "bytes",
		pull(controller) {
			partialRespondPulls++;
			const request = controller.byobRequest;
			const exposedView = request.view;
			exposedView[0] = partialRespondPulls;
			request.respond(1);
			partialRespondTransferred &&= exposedView.buffer.byteLength === 0;
			if (partialRespondPulls === 4) controller.close();
		},
	});
	const partialRespondReader = partialRespondStream.getReader({ mode: "byob" });
	const partialRespondInput = new Uint32Array(1);
	const partialRespondPromise = partialRespondReader.read(partialRespondInput);
	const partialRespondInputTransferred = partialRespondInput.buffer.byteLength === 0;
	const partialRespondRead = await partialRespondPromise;
	check(
		"BYOB respond accumulates partial elements",
		partialRespondInputTransferred &&
			partialRespondTransferred &&
			partialRespondPulls === 4 &&
			partialRespondRead.value instanceof Uint32Array &&
			partialRespondRead.value.byteLength === 4 &&
			new Uint8Array(partialRespondRead.value.buffer)[0] === 1 &&
			new Uint8Array(partialRespondRead.value.buffer)[3] === 4,
	);

	let transferredReplacementDetached = false;
	const transferredReplacementStream = new ReadableStream({
		type: "bytes",
		pull(controller) {
			const exposed = controller.byobRequest.view;
			const byteOffset = exposed.byteOffset;
			const byteLength = exposed.byteLength;
			const transferred = new Uint8Array(
				exposed.buffer.transfer(),
				byteOffset,
				byteLength,
			);
			transferred[0] = 9;
			controller.byobRequest.respondWithNewView(transferred);
			transferredReplacementDetached = transferred.buffer.byteLength === 0;
		},
	});
	const transferredReplacementRead = await transferredReplacementStream
		.getReader({ mode: "byob" })
		.read(new Uint8Array(1));
	check(
		"BYOB accepts a replacement view over the transferred request buffer",
		transferredReplacementDetached && transferredReplacementRead.value[0] === 9,
	);

	let excessRespondPulls = 0;
	const excessRespondStream = new ReadableStream({
		type: "bytes",
		pull(controller) {
			excessRespondPulls++;
			const request = controller.byobRequest;
			request.view[0] = 1;
			request.view[1] = 2;
			request.view[2] = 3;
			request.respond(3);
		},
	});
	const excessRespondReader = excessRespondStream.getReader({ mode: "byob" });
	const excessRespondFirst = await excessRespondReader.read(new Uint16Array(2));
	const excessRespondSecond = await excessRespondReader.read(new Uint8Array(1));
	check(
		"BYOB respond queues bytes beyond an element boundary",
		excessRespondPulls === 1 &&
			excessRespondFirst.value.byteLength === 2 &&
			new Uint8Array(excessRespondFirst.value.buffer)[0] === 1 &&
			new Uint8Array(excessRespondFirst.value.buffer)[1] === 2 &&
			excessRespondSecond.value[0] === 3,
	);
	await excessRespondReader.cancel();

	let queuedPartialPulls = 0;
	const queuedPartialStream = new ReadableStream({
		type: "bytes",
		start(controller) {
			controller.enqueue(new Uint8Array([0xff]));
		},
		pull(controller) {
			queuedPartialPulls++;
			controller.byobRequest.view[0] = 0xaa;
			controller.byobRequest.respond(1);
			controller.close();
		},
	});
	const queuedPartialRead = await queuedPartialStream
		.getReader({ mode: "byob" })
		.read(new Uint16Array(1));
	check(
		"queued bytes and pull responses combine into one BYOB element",
		queuedPartialPulls === 1 &&
			queuedPartialRead.value.byteLength === 2 &&
			new Uint8Array(queuedPartialRead.value.buffer)[0] === 0xff &&
			new Uint8Array(queuedPartialRead.value.buffer)[1] === 0xaa,
	);

	let incompleteCloseController;
	const incompleteCloseStream = new ReadableStream({
		type: "bytes",
		start(controller) {
			incompleteCloseController = controller;
			controller.enqueue(new Uint8Array([0xff]));
		},
	});
	const incompleteCloseReader = incompleteCloseStream.getReader({ mode: "byob" });
	const incompleteCloseRead = incompleteCloseReader.read(new Uint16Array(1)).then(
		() => false,
		(error) => error instanceof TypeError,
	);
	let incompleteCloseThrew = false;
	try {
		incompleteCloseController.close();
	} catch (error) {
		incompleteCloseThrew = error instanceof TypeError;
	}
	const incompleteCloseClosed = incompleteCloseReader.closed.then(
		() => false,
		(error) => error instanceof TypeError,
	);
	check(
		"closing a BYOB read with an incomplete element errors the stream",
		incompleteCloseThrew && (await incompleteCloseRead) && (await incompleteCloseClosed),
	);

	let zeroCloseController;
	let zeroCloseRequest;
	const zeroCloseStream = new ReadableStream({
		type: "bytes",
		pull(controller) {
			zeroCloseController = controller;
			zeroCloseRequest = controller.byobRequest;
			controller.close();
			zeroCloseRequest.respond(0);
		},
	});
	const zeroCloseRead = await zeroCloseStream
		.getReader({ mode: "byob" })
		.read(new Uint8Array([4, 5, 6]));
	let secondZeroRespondRejected = false;
	try {
		zeroCloseRequest.respond(0);
	} catch (error) {
		secondZeroRespondRejected = error instanceof TypeError;
	}
	check(
		"closed BYOB requests accept one zero-byte response",
		zeroCloseController.byobRequest === null &&
			zeroCloseRead.done &&
			zeroCloseRead.value.byteLength === 0 &&
			zeroCloseRead.value.buffer.byteLength === 3 &&
			new Uint8Array(zeroCloseRead.value.buffer)[2] === 6 &&
			secondZeroRespondRejected,
	);

	let multiCloseController;
	const multiCloseStream = new ReadableStream({
		type: "bytes",
		start(controller) {
			multiCloseController = controller;
		},
	});
	const multiCloseReader = multiCloseStream.getReader({ mode: "byob" });
	const multiCloseFirst = multiCloseReader.read(new Uint8Array(2));
	const multiCloseSecond = multiCloseReader.read(new Uint8Array(3));
	multiCloseController.close();
	multiCloseController.byobRequest.respond(0);
	const [multiCloseFirstResult, multiCloseSecondResult] = await Promise.all([
		multiCloseFirst,
		multiCloseSecond,
	]);
	check(
		"one zero response closes multiple pending BYOB reads",
		multiCloseFirstResult.done &&
			multiCloseFirstResult.value.buffer.byteLength === 2 &&
			multiCloseSecondResult.done &&
			multiCloseSecondResult.value.buffer.byteLength === 3,
	);

	let multiPendingController;
	const multiPendingStream = new ReadableStream({
		type: "bytes",
		start(controller) {
			multiPendingController = controller;
		},
	});
	const multiPendingReader = multiPendingStream.getReader({ mode: "byob" });
	const multiPendingFirst = multiPendingReader.read(new Uint8Array(4));
	const multiPendingSecond = multiPendingReader.read(new Uint8Array(4));
	multiPendingController.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
	const [multiPendingFirstResult, multiPendingSecondResult] = await Promise.all([
		multiPendingFirst,
		multiPendingSecond,
	]);
	check(
		"one byte enqueue fills multiple pending BYOB reads",
		multiPendingFirstResult.value.byteLength === 4 &&
			multiPendingFirstResult.value[3] === 4 &&
			multiPendingSecondResult.value.byteLength === 2 &&
			multiPendingSecondResult.value[0] === 5 &&
			multiPendingSecondResult.value[1] === 6,
	);

	let handoffController;
	const handoffStream = new ReadableStream({
		type: "bytes",
		start(controller) {
			handoffController = controller;
		},
	});
	const handoffReader1 = handoffStream.getReader({ mode: "byob" });
	const handoffRead1 = handoffReader1.read(new Uint8Array(3));
	const handoffRequest = handoffController.byobRequest;
	const handoffRead1Rejected = handoffRead1.then(
		() => false,
		(error) => error instanceof TypeError,
	);
	const handoffClosed1Rejected = handoffReader1.closed.then(
		() => false,
		(error) => error instanceof TypeError,
	);
	handoffReader1.releaseLock();
	const handoffReader2 = handoffStream.getReader({ mode: "byob" });
	const handoffRead2 = handoffReader2.read(new Uint8Array(3));
	handoffRequest.view[0] = 11;
	handoffRequest.respond(1);
	const handoffResult = await handoffRead2;
	check(
		"a live BYOB request survives reader release and fills the next read",
		(await handoffRead1Rejected) &&
			(await handoffClosed1Rejected) &&
			handoffController.byobRequest === null &&
			handoffResult.value.byteLength === 1 &&
			handoffResult.value.buffer.byteLength === 3 &&
			handoffResult.value[0] === 11,
	);
	await handoffReader2.cancel();

	let partialHandoffController;
	const partialHandoffStream = new ReadableStream({
		type: "bytes",
		start(controller) {
			partialHandoffController = controller;
		},
	});
	const partialHandoffReader1 = partialHandoffStream.getReader({ mode: "byob" });
	const partialHandoffRead1 = partialHandoffReader1.read(new Uint16Array(1));
	partialHandoffRead1.catch(() => {});
	partialHandoffReader1.closed.catch(() => {});
	partialHandoffController.byobRequest.view[0] = 0x11;
	partialHandoffController.byobRequest.respond(1);
	const partialHandoffRequest = partialHandoffController.byobRequest;
	partialHandoffReader1.releaseLock();
	const partialHandoffReader2 = partialHandoffStream.getReader({ mode: "byob" });
	const partialHandoffRead2 = partialHandoffReader2.read(new Uint16Array(1));
	partialHandoffRequest.view[0] = 0x22;
	partialHandoffRequest.respond(1);
	const partialHandoffResult = await partialHandoffRead2;
	check(
		"partial BYOB elements survive reader handoff",
		partialHandoffResult.value.byteLength === 2 &&
			new Uint8Array(partialHandoffResult.value.buffer)[0] === 0x11 &&
			new Uint8Array(partialHandoffResult.value.buffer)[1] === 0x22,
	);
	await partialHandoffReader2.cancel();

	let enqueueHandoffController;
	const enqueueHandoffStream = new ReadableStream({
		type: "bytes",
		start(controller) {
			enqueueHandoffController = controller;
		},
	});
	const enqueueHandoffReader1 = enqueueHandoffStream.getReader({ mode: "byob" });
	const enqueueHandoffRead1 = enqueueHandoffReader1.read(new Uint16Array(1));
	enqueueHandoffRead1.catch(() => {});
	enqueueHandoffReader1.closed.catch(() => {});
	enqueueHandoffController.byobRequest.view[0] = 0x11;
	enqueueHandoffController.byobRequest.respond(1);
	enqueueHandoffReader1.releaseLock();
	const enqueueHandoffReader2 = enqueueHandoffStream.getReader();
	const enqueueHandoffRead2 = enqueueHandoffReader2.read();
	enqueueHandoffController.enqueue(new Uint8Array([0x22]));
	const enqueueHandoffResult2 = await enqueueHandoffRead2;
	const enqueueHandoffResult3 = await enqueueHandoffReader2.read();
	check(
		"enqueue splits a partial released descriptor from the new chunk",
		enqueueHandoffResult2.value.byteLength === 1 &&
			enqueueHandoffResult2.value.buffer.byteLength === 1 &&
			enqueueHandoffResult2.value[0] === 0x11 &&
			enqueueHandoffResult3.value.byteLength === 1 &&
			enqueueHandoffResult3.value[0] === 0x22,
	);
	await enqueueHandoffReader2.cancel();

	let minimumPullCount = 0;
	const minimumStream = new ReadableStream({
		type: "bytes",
		pull(controller) {
			const request = controller.byobRequest;
			if (minimumPullCount === 0) {
				request.view[0] = 1;
				request.view[1] = 2;
				request.respond(2);
			} else {
				request.view[0] = 3;
				request.respond(1);
			}
			minimumPullCount++;
		},
	});
	const minimumReader = minimumStream.getReader({ mode: "byob" });
	const minimumResult = await minimumReader.read(new Uint8Array(3), { min: 3 });
	check(
		"BYOB read minimum accumulates responses before fulfillment",
		minimumPullCount === 2 &&
			minimumResult.value.byteLength === 3 &&
			minimumResult.value[0] === 1 &&
			minimumResult.value[2] === 3,
	);
	const invalidMinimumRejected = await minimumReader
		.read(new Uint8Array(1), { min: 0 })
		.then(
			() => false,
			(error) => error instanceof TypeError,
		);
	check("BYOB read rejects an invalid minimum", invalidMinimumRejected);
	const fractionalMinimumRejected = await minimumReader
		.read(new Uint8Array(1), { min: 0.5 })
		.then(
			() => false,
			(error) => error instanceof TypeError,
		);
	check("BYOB read validates the converted minimum", fractionalMinimumRejected);
	await minimumReader.cancel();

	let dataViewPullCount = 0;
	const dataViewStream = new ReadableStream({
		type: "bytes",
		pull(controller) {
			const request = controller.byobRequest;
			request.view[0] = dataViewPullCount + 4;
			request.respond(1);
			dataViewPullCount++;
		},
	});
	const dataViewReader = dataViewStream.getReader({ mode: "byob" });
	const dataViewResult = await dataViewReader.read(new DataView(new ArrayBuffer(2)), {
		min: 2,
	});
	check(
		"BYOB DataView reads preserve the result view type",
		dataViewPullCount === 2 &&
			dataViewResult.value instanceof DataView &&
			dataViewResult.value.byteLength === 2 &&
			dataViewResult.value.getUint8(0) === 4 &&
			dataViewResult.value.getUint8(1) === 5,
	);
	await dataViewReader.cancel();

	const multiQueueStream = new ReadableStream({
		type: "bytes",
		start(controller) {
			controller.enqueue(new Uint8Array(16).fill(1));
			controller.enqueue(new Uint8Array(8).fill(2));
		},
	});
	const multiQueueRead = await multiQueueStream
		.getReader({ mode: "byob" })
		.read(new Uint8Array(24));
	check(
		"one BYOB read drains multiple queued byte chunks",
		multiQueueRead.value.byteLength === 24 &&
			multiQueueRead.value[15] === 1 &&
			multiQueueRead.value[16] === 2 &&
			multiQueueRead.value[23] === 2,
	);

	let byteCrossBrandRejected = false;
	try {
		ReadableStreamDefaultController.prototype.enqueue.call(
			byteController,
			new Uint8Array([1]),
		);
	} catch (error) {
		byteCrossBrandRejected = error instanceof TypeError;
	}
	let directByteControllerRejected = false;
	let directByobRequestRejected = false;
	try {
		new ReadableByteStreamController();
	} catch (error) {
		directByteControllerRejected = error instanceof TypeError;
	}
	try {
		new ReadableStreamBYOBRequest(byteController, new Uint8Array(1));
	} catch (error) {
		directByobRequestRejected = error instanceof TypeError;
	}
	check(
		"byte stream brands and direct constructors",
		byteCrossBrandRejected && directByteControllerRejected && directByobRequestRejected,
	);
	let byteStrategySizeRejected = false;
	try {
		new ReadableStream({ type: "bytes" }, { size() {} });
	} catch (error) {
		byteStrategySizeRejected = error instanceof RangeError;
	}
	check("byte stream rejects a strategy size function", byteStrategySizeRejected);

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

	const queuedByteTeeSource = new ReadableStream({
		type: "bytes",
		start(controller) {
			controller.enqueue(new Uint8Array([1]));
			controller.enqueue(new Uint8Array([2]));
			controller.close();
		},
	});
	const [queuedByteBranch1, queuedByteBranch2] = queuedByteTeeSource.tee();
	const queuedByteReader1 = queuedByteBranch1.getReader({ mode: "byob" });
	const queuedByteReader2 = queuedByteBranch2.getReader({ mode: "byob" });
	let queuedByteReader2Closed = false;
	queuedByteReader2.closed.then(() => {
		queuedByteReader2Closed = true;
	});
	const queuedByteTimeout = new Promise((resolve) => {
		setTimeout(() => resolve({ timeout: true }), 100);
	});
	const queuedByteFirst = await Promise.race([
		queuedByteReader1.read(new Uint8Array(1)),
		queuedByteTimeout,
	]);
	const queuedByteSecond = await Promise.race([
		queuedByteReader1.read(new Uint8Array(1)),
		queuedByteTimeout,
	]);
	const queuedByteDone = await Promise.race([
		queuedByteReader1.read(new Uint8Array(1)),
		queuedByteTimeout,
	]);
	check("byte tee first queued chunk", queuedByteFirst.value?.[0] === 1);
	check("byte tee second queued chunk", queuedByteSecond.value?.[0] === 2);
	check("byte tee closes after queued chunks", queuedByteDone.done === true);
	const queuedByteOtherFirst = await queuedByteReader2.read(new Uint8Array(1));
	await tick();
	check(
		"byte tee keeps a queued peer branch open",
		queuedByteOtherFirst.value?.[0] === 1 && !queuedByteReader2Closed,
	);
	check(
		"byte tee closes the drained branch reader",
		(await queuedByteReader1.closed) === undefined,
	);

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

	const pipeAbortReason = { marker: "pipe aborted" };
	let pipeCancelReason;
	let pipeAbortSinkReason;
	const abortablePipeSource = new ReadableStream({
		cancel(reason) {
			pipeCancelReason = reason;
		},
	});
	const abortablePipeDestination = new WritableStream({
		abort(reason) {
			pipeAbortSinkReason = reason;
		},
	});
	const pipeAbortController = new AbortController();
	const abortedPipe = abortablePipeSource.pipeTo(abortablePipeDestination, {
		signal: pipeAbortController.signal,
	});
	pipeAbortController.abort(pipeAbortReason);
	const pipeRejection = await abortedPipe.catch((error) => error);
	check(
		"pipeTo abort preserves reason and releases locks",
		pipeRejection === pipeAbortReason &&
			pipeCancelReason === pipeAbortReason &&
			pipeAbortSinkReason === pipeAbortReason &&
			!abortablePipeSource.locked &&
			!abortablePipeDestination.locked,
	);

	let completedPipeController;
	let completedPipeWasAborted = false;
	const completedPipeSource = new ReadableStream({
		start(controller) {
			completedPipeController = controller;
		},
	});
	const completedPipeDestination = new WritableStream({
		abort() {
			completedPipeWasAborted = true;
		},
	});
	const completedPipeAbortController = new AbortController();
	const completedPipe = completedPipeSource.pipeTo(completedPipeDestination, {
		signal: completedPipeAbortController.signal,
	});
	completedPipeController.close();
	await completedPipe;
	completedPipeAbortController.abort();
	await tick();
	check("completed pipe removes its abort algorithm", !completedPipeWasAborted);
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
