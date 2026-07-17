import { EventEmitter } from "node:events";
import Stream, {
	Duplex,
	Readable,
	Stream as NamedStream,
	Transform,
	Writable,
} from "node:stream";
import { inherits } from "node:util";

let passed = 0;
let total = 0;

function check(condition, name) {
	total++;
	if (condition) passed++;
	else console.log("FAIL: " + name);
}

async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

async function main() {
	check(Stream === NamedStream && typeof Stream === "function", "default legacy Stream");
	check(
		Stream.Stream === Stream &&
			Stream.Readable === Readable &&
			Stream.Writable === Writable &&
			Stream.Duplex === Duplex &&
			Stream.Transform === Transform,
		"constructor properties",
	);
	check(
		Stream() instanceof Stream &&
			Readable() instanceof Readable &&
			Writable() instanceof Writable &&
			Duplex() instanceof Duplex &&
			Transform() instanceof Transform,
		"constructors callable without new",
	);
	const emitterBacked = new Readable();
	let emitterSemantics = 0;
	emitterBacked.once("native-event", () => {
		emitterSemantics++;
	});
	emitterBacked.emit("native-event");
	emitterBacked.emit("native-event");
	check(
		emitterSemantics === 1 && emitterBacked.listenerCount("native-event") === 0,
		"EventEmitter semantics",
	);
	check(emitterBacked instanceof EventEmitter, "shared EventEmitter identity");

	function SendStyle() {
		Stream.call(this);
		this.statusCode = 200;
	}
	inherits(SendStyle, Stream);
	const send = new SendStyle();
	let sent = false;
	send.on("send", () => {
		sent = true;
	});
	send.emit("send");
	check(
		sent && send.statusCode === 200 && send instanceof Stream,
		"send-style Stream.call",
	);
	send.extra = "extensible";
	check(send.extra === "extensible", "ordinary extensible properties");

	const readable = new Readable({ encoding: "utf8" });
	check(
		readable.readable === true &&
			readable.destroyed === false &&
			readable._readableState.encoding === "utf8" &&
			readable._readableState.decoder.encoding === "utf8",
		"readable state and decoder",
	);
	readable.setEncoding("latin1");
	check(
		readable._readableState.encoding === "latin1" &&
			readable._readableState.decoder.encoding === "latin1",
		"setEncoding state",
	);
	const flowing = [];
	readable.push("queued");
	readable.on("data", (chunk) => {
		flowing.push(chunk);
		if (chunk === "first") readable.pause();
	});
	check(
		flowing.join(",") === "queued" && !readable.isPaused(),
		"data listener starts flow",
	);
	readable.push("first");
	readable.push("held");
	check(flowing.join(",") === "queued,first" && readable.isPaused(), "pause queues data");
	readable.resume();
	readable.push(null);
	await Promise.resolve();
	let lateEnd = false;
	readable.on("end", () => {
		lateEnd = true;
	});
	check(
		flowing.join(",") === "queued,first,held" &&
			readable.readableEnded &&
			!readable.readable,
		"resume drains and ends",
	);
	check(lateEnd === false, "end emitted once while flowing");

	const reentrant = new Readable();
	const reentrantChunks = [];
	reentrant.on("data", (chunk) => {
		reentrantChunks.push(chunk);
		if (chunk === "first") {
			reentrant.pause();
			reentrant.push("second");
		}
	});
	reentrant.push("first");
	check(reentrantChunks.join(",") === "first", "reentrant push remains paused");
	reentrant.resume();
	check(
		reentrantChunks.join(",") === "first,second",
		"reentrant push survives queue drain",
	);

	const source = new Readable();
	const destination = new Writable();
	const piped = [];
	let pipeEvents = 0;
	let unpipeEvents = 0;
	destination.on("pipe", () => pipeEvents++);
	destination.on("unpipe", () => unpipeEvents++);
	destination.write = function (chunk) {
		piped.push(chunk);
		return false;
	};
	check(
		source.pipe(destination) === destination && pipeEvents === 1,
		"pipe return and event",
	);
	source.push("a");
	source.push("b");
	check(piped.join(",") === "a" && source.isPaused(), "write false pauses source");
	destination.emit("drain");
	check(piped.join(",") === "a,b", "drain resumes queued data");
	source.unpipe(destination);
	source.push("c");
	check(piped.join(",") === "a,b" && unpipeEvents === 1, "unpipe stops writes");
	destination.emit("drain");
	check(source.isPaused(), "stale drain does not resume unpiped source");

	const endingSource = new Readable();
	const endingDestination = new Writable();
	let pipeFinished = false;
	endingDestination._write = (chunk, encoding, done) => done();
	endingDestination.on("finish", () => {
		pipeFinished = true;
	});
	endingSource.pipe(endingDestination);
	endingSource.push("last");
	endingSource.push(null);
	await settle();
	check(pipeFinished && endingDestination.writableFinished, "pipe ends destination");

	function MemoryWritable() {
		Writable.call(this);
		this.chunks = [];
	}
	inherits(MemoryWritable, Writable);
	MemoryWritable.prototype._write = function (chunk, encoding, done) {
		this.chunks.push(chunk + ":" + encoding);
		done();
	};
	const writable = new MemoryWritable();
	const writableOrder = [];
	writable.on("finish", () => writableOrder.push("finish"));
	check(writable.write("x", () => writableOrder.push("write")) === true, "write return");
	writable.end("y", () => writableOrder.push("end"));
	check(writableOrder.length === 0, "write and end callbacks are deferred");
	await settle();
	check(
		writable.chunks.join(",") === "x:buffer,y:buffer" &&
			writableOrder.join(",") === "write,end,finish" &&
			writable.writableEnded &&
			writable.writableFinished &&
			!writable.writable,
		"writable callbacks and finish",
	);

	function IconvStyle(options) {
		Transform.call(this, options);
		this.calls = [];
	}
	inherits(IconvStyle, Transform);
	IconvStyle.prototype._transform = function (chunk, encoding, done) {
		this.calls.push(chunk + ":" + encoding);
		done(null, chunk + "!");
	};
	IconvStyle.prototype._flush = function (done) {
		done(null, "flush");
	};
	const transform = new IconvStyle({ objectMode: true });
	const transformed = [];
	const transformOrder = [];
	transform.on("data", (chunk) => transformed.push(chunk));
	transform.on("end", () => transformOrder.push("end"));
	transform.on("finish", () => transformOrder.push("finish"));
	transform.write("one", () => transformOrder.push("write"));
	transform.end("two", () => transformOrder.push("end-callback"));
	check(
		transformed.length === 0 && transformOrder.length === 0,
		"transform completion is deferred",
	);
	await settle();
	check(
		transform.calls.join(",") === "one:buffer,two:buffer" &&
			transformed.join(",") === "one!,two!,flush",
		"iconv-style inherited transform",
	);
	check(
		transformOrder.join(",") === "write,end,end-callback,finish" &&
			transform.readableEnded &&
			transform.writableFinished,
		"transform flush and lifecycle",
	);

	const deferred = new Transform();
	const deferredOutput = [];
	const deferredCallbacks = [];
	let completeFirst;
	deferred._transform = (chunk, encoding, done) => {
		if (chunk === "a") completeFirst = done;
		else done(null, chunk);
	};
	deferred.on("data", (chunk) => deferredOutput.push(chunk));
	deferred.write("a", () => deferredCallbacks.push("a"));
	deferred.write("b", () => deferredCallbacks.push("b"));
	check(deferredOutput.length === 0, "transform serializes pending writes");
	completeFirst(null, "a");
	await settle();
	check(
		deferredOutput.join(",") === "a,b" && deferredCallbacks.join(",") === "a,b",
		"native transform callback retains queue",
	);

	const failed = new Transform();
	const failure = new Error("transform failure");
	const failureOrder = [];
	let callbackError;
	failed._transform = (chunk, encoding, done) => done(failure);
	failed.on("error", (error) => failureOrder.push(error === failure ? "error" : "wrong"));
	failed.on("close", () => failureOrder.push("close"));
	failed.write("bad", (error) => {
		callbackError = error;
		failureOrder.push("callback");
	});
	check(failureOrder.length === 0, "transform errors are deferred");
	await settle();
	failed.destroy(failure);
	check(
		callbackError === failure &&
			failureOrder.join(",") === "callback,error,close" &&
			failed.destroyed &&
			failed.listenerCount("error") === 1,
		"transform error and idempotent destroy listener retention",
	);

	const optionTransform = new Transform({
		objectMode: true,
		transform(chunk, encoding, done) {
			done(null, chunk + "-option");
		},
		flush(done) {
			done(null, "option-flush");
		},
	});
	const optionOutput = [];
	optionTransform.on("data", (chunk) => optionOutput.push(chunk));
	optionTransform.end("value");
	await settle();
	check(
		optionOutput.join(",") === "value-option,option-flush",
		"constructor transform and flush options",
	);

	const duplex = new Duplex();
	const duplexData = [];
	duplex.on("data", (chunk) => duplexData.push(chunk));
	duplex.push("read");
	duplex.end();
	await settle();
	check(
		duplexData.join(",") === "read" && duplex.writableFinished && duplex.readable,
		"duplex combines independent sides",
	);

	const backpressured = new Writable({ highWaterMark: 2 });
	const backpressureOrder = [];
	let releaseBackpressure;
	backpressured._write = (chunk, encoding, done) => {
		releaseBackpressure = done;
	};
	backpressured.on("drain", () => backpressureOrder.push("drain"));
	check(
		backpressured.write("ab", () => backpressureOrder.push("callback")) === false &&
			backpressured._writableState.length === 2 &&
			backpressured._writableState.needDrain,
		"finite highWaterMark return and buffered length",
	);
	releaseBackpressure();
	check(backpressureOrder.length === 0, "synchronous write done remains deferred");
	await Promise.resolve();
	check(
		backpressureOrder.join(",") === "callback,drain" &&
			backpressured._writableState.length === 0 &&
			!backpressured._writableState.needDrain,
		"buffer drain transition",
	);

	const multiSource = new Readable();
	const firstDestination = new Writable();
	const secondDestination = new Writable();
	const firstChunks = [];
	const secondChunks = [];
	firstDestination.write = (chunk) => {
		firstChunks.push(chunk);
		return false;
	};
	secondDestination.write = (chunk) => {
		secondChunks.push(chunk);
		return false;
	};
	multiSource.pipe(firstDestination);
	multiSource.pipe(secondDestination);
	multiSource.push("one");
	multiSource.push("two");
	firstDestination.emit("drain");
	check(
		firstChunks.join(",") === "one" &&
			secondChunks.join(",") === "one" &&
			multiSource.isPaused(),
		"first destination drain waits for all blocked pipes",
	);
	secondDestination.emit("drain");
	check(
		firstChunks.join(",") === "one,two" && secondChunks.join(",") === "one,two",
		"last destination drain resumes source",
	);
	multiSource.unpipe(firstDestination);
	multiSource.unpipe(secondDestination);
	check(
		multiSource.isPaused() &&
			firstDestination.listenerCount("drain") === 0 &&
			secondDestination.listenerCount("drain") === 0,
		"unpipe detaches pending drain listeners and stops flow",
	);
	multiSource.push("buffered-after-unpipe");
	check(
		firstChunks.length === 2 &&
			secondChunks.length === 2 &&
			multiSource._malReadableQueue.length === 1,
		"unpipe buffers subsequent chunks",
	);

	const queuedFailure = new Transform();
	const queuedError = new Error("queued failure");
	const queuedErrors = [];
	let failQueued;
	queuedFailure._transform = (chunk, encoding, done) => {
		if (chunk === "first") failQueued = done;
		else done(null, chunk);
	};
	queuedFailure.on("error", () => {});
	queuedFailure.write("first", (error) => queuedErrors.push(["first", error]));
	queuedFailure.write("second", (error) => queuedErrors.push(["second", error]));
	queuedFailure.end((error) => queuedErrors.push(["end", error]));
	failQueued(queuedError);
	await settle();
	check(
		queuedErrors.length === 3 &&
			queuedErrors.every((entry) => entry[1] === queuedError) &&
			queuedErrors.map((entry) => entry[0]).join(",") === "first,second,end",
		"queued write and end callbacks receive transform error",
	);

	const flushFailure = new Transform();
	const flushError = new Error("flush failure");
	let finishFlush;
	let flushCallbackError;
	flushFailure._transform = (chunk, encoding, done) => done(null, chunk);
	flushFailure._flush = (done) => {
		finishFlush = done;
	};
	flushFailure.on("error", () => {});
	flushFailure.end("value", (error) => {
		flushCallbackError = error;
	});
	await settle();
	finishFlush(flushError);
	await settle();
	check(
		flushCallbackError === flushError && flushFailure.destroyed,
		"end callback receives asynchronous flush error",
	);

	const syncWriteFailure = new Writable();
	const syncWriteError = new Error("sync write throw");
	let syncWriteCallbackError;
	syncWriteFailure._write = () => {
		throw syncWriteError;
	};
	syncWriteFailure.on("error", () => {});
	syncWriteFailure.write("value", (error) => {
		syncWriteCallbackError = error;
	});
	await settle();
	check(
		syncWriteCallbackError === syncWriteError && syncWriteFailure.destroyed,
		"synchronous _write throw fails and destroys",
	);

	const syncTransformFailure = new Transform();
	const syncTransformError = new Error("sync transform throw");
	let syncTransformCallbackError;
	syncTransformFailure._transform = () => {
		throw syncTransformError;
	};
	syncTransformFailure.on("error", () => {});
	syncTransformFailure.write("value", (error) => {
		syncTransformCallbackError = error;
	});
	await settle();
	check(
		syncTransformCallbackError === syncTransformError && syncTransformFailure.destroyed,
		"synchronous _transform throw fails and destroys",
	);

	const syncFlushFailure = new Transform();
	const syncFlushError = new Error("sync flush throw");
	let syncFlushCallbackError;
	syncFlushFailure._transform = (chunk, encoding, done) => done();
	syncFlushFailure._flush = () => {
		throw syncFlushError;
	};
	syncFlushFailure.on("error", () => {});
	syncFlushFailure.end("value", (error) => {
		syncFlushCallbackError = error;
	});
	await settle();
	check(
		syncFlushCallbackError === syncFlushError && syncFlushFailure.destroyed,
		"synchronous _flush throw fails and destroys",
	);

	const transactionalEnd = new Writable();
	let endThrow;
	try {
		transactionalEnd.end({ length: 1 });
	} catch (error) {
		endThrow = error;
	}
	check(
		endThrow instanceof TypeError &&
			!transactionalEnd.writableEnded &&
			!transactionalEnd._writableState.ended,
		"invalid end chunk does not mark ended",
	);

	console.log("RESULT " + passed + "/" + total);
}

main();
