const results = [];

function check(name, condition) {
	results.push([name, !!condition]);
}

async function run() {
	check(
		"globals",
		typeof WritableStream === "function" &&
			typeof WritableStreamDefaultController === "function" &&
			typeof WritableStreamDefaultWriter === "function",
	);

	const events = [];
	let controller;
	const stream = new WritableStream({
		start(value) {
			controller = value;
			events.push("start", arguments.length);
		},
		write(chunk, value) {
			events.push("write", chunk, value === controller, arguments.length);
		},
		close() {
			events.push("close", arguments.length);
		},
	});
	check("start controller", events[0] === "start" && events[1] === 1);
	check("initial unlocked", stream.locked === false);
	const writer = stream.getWriter();
	check("writer lock", stream.locked && writer.desiredSize === 1);
	await writer.write("a");
	await writer.close();
	await writer.closed;
	check("write and close calls", events.join(",") === "start,1,write,a,true,2,close,0");
	check("closed desired size", writer.desiredSize === 0);
	let closeArgumentCount = -1;
	const restCloseWriter = new WritableStream({
		close(...args) {
			closeArgumentCount = args.length;
		},
	}).getWriter();
	await restCloseWriter.close();
	check("close receives no arguments", closeArgumentCount === 0);

	let resolveWrite;
	const backpressured = new WritableStream(
		{
			write() {
				return new Promise((resolve) => {
					resolveWrite = resolve;
				});
			},
		},
		{
			highWaterMark: 1,
			size() {
				return 1;
			},
		},
	);
	const backpressureWriter = backpressured.getWriter();
	const writePromise = backpressureWriter.write("chunk");
	check("backpressure desired size", backpressureWriter.desiredSize === 0);
	let readySettled = false;
	backpressureWriter.ready.then(() => {
		readySettled = true;
	});
	await Promise.resolve();
	check("ready stays pending", !readySettled);
	resolveWrite();
	await writePromise;
	await backpressureWriter.ready;
	check("backpressure released", backpressureWriter.desiredSize === 1);

	const controllerError = new Error("controller error");
	let errorController;
	const errored = new WritableStream({
		start(value) {
			errorController = value;
		},
	});
	errorController.error(controllerError);
	const errorWriter = errored.getWriter();
	const errorResults = await Promise.all([
		errorWriter.closed.then(
			() => false,
			(error) => error === controllerError,
		),
		errorWriter.ready.then(
			() => false,
			(error) => error === controllerError,
		),
		errorWriter.write("x").then(
			() => false,
			(error) => error === controllerError,
		),
	]);
	check(
		"controller error",
		errorWriter.desiredSize === null && errorResults.every(Boolean),
	);

	const abortReason = new Error("abort reason");
	let observedAbort;
	const aborted = new WritableStream({
		abort(reason) {
			observedAbort = reason;
		},
	});
	const abortWriter = aborted.getWriter();
	await abortWriter.ready;
	await abortWriter.abort(abortReason);
	const closedReason = await abortWriter.closed.then(
		() => undefined,
		(error) => error,
	);
	check("abort", observedAbort === abortReason && closedReason === abortReason);

	const releasedStream = new WritableStream();
	const releasedWriter = releasedStream.getWriter();
	releasedWriter.releaseLock();
	const releaseErrors = await Promise.all([
		releasedWriter.ready.then(
			() => undefined,
			(error) => error,
		),
		releasedWriter.closed.then(
			() => undefined,
			(error) => error,
		),
	]);
	let desiredSizeThrows = false;
	try {
		releasedWriter.desiredSize;
	} catch (error) {
		desiredSizeThrows = error instanceof TypeError;
	}
	check(
		"release lock",
		desiredSizeThrows &&
			releaseErrors[0] instanceof TypeError &&
			releaseErrors[0] === releaseErrors[1] &&
			!releasedStream.locked,
	);

	class WritableSubclass extends WritableStream {}
	const subclass = new WritableSubclass();
	check(
		"subclass",
		subclass instanceof WritableSubclass && subclass instanceof WritableStream,
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
