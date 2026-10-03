import {
	createWorkerUrl,
	createPool,
	Worker,
	MessageChannel,
	MessagePort,
	receiveMessageOnPort,
} from "maligator:workers";

function check(value, message) {
	if (!value) throw new Error(message);
}
function message(port) {
	return new Promise((resolve) =>
		port.addEventListener("message", (event) => resolve(event.data), { once: true }),
	);
}
const echo = createWorkerUrl("./echo.mjs", import.meta.url);
check(Object.isFrozen(echo), "immutable entry");
check(structuredClone(echo).href === echo.href, "cloneable entry");
const worker = new Worker(echo, { data: { amount: 3 } });
worker.port.start();
await worker.ready;
const pathResponse = message(worker.port);
worker.port.postMessage({ filename: "fixtures/child-only.mjs" });
check((await pathResponse) === "child-only.mjs", "child-only host installer");
const bytes = new Uint8Array([2, 4]);
const returned = message(worker.port);
worker.port.postMessage({ bytes }, [bytes.buffer]);
check(bytes.buffer.byteLength === 0, "sender detached synchronously");
check(
	JSON.stringify(Array.from((await returned).bytes)) === "[2,4]",
	"transferred bytes",
);

const channel = new MessageChannel();
check(channel.port1 instanceof MessagePort, "port identity");
worker.port.postMessage({ port: channel.port2 }, [channel.port2]);
const sum = message(channel.port1);
channel.port1.start();
channel.port1.postMessage(9);
check((await sum) === 12, "transferred endpoint");
channel.port1.close();
const shared = new SharedArrayBuffer(16, { maxByteLength: 32 });
const sharedResponse = message(worker.port);
worker.port.postMessage({ shared });
await sharedResponse;
check(
	shared.byteLength === 24 && new Int32Array(shared)[1] === 19,
	"shared write and growth",
);
const firstExit = await worker.terminate();
check((await worker.terminate()).id === firstExit.id, "idempotent complete termination");

const bounded = new MessageChannel({ maxQueuedMessages: 1 });
const first = new ArrayBuffer(4);
bounded.port1.postMessage(first, [first]);
const second = new ArrayBuffer(4);
let rejected = false;
try {
	bounded.port1.postMessage(second, [second]);
} catch {
	rejected = true;
}
check(rejected && second.byteLength === 4, "rejected transfer preserves ownership");
check(
	receiveMessageOnPort(bounded.port2).message.byteLength === 4,
	"synchronous receive",
);
bounded.port1.close();
bounded.port2.close();

const jobs = createWorkerUrl("./jobs.mjs", import.meta.url);
const pool = createPool(jobs, { size: 1, maxQueuedTasks: 2 });
await pool.ready;
check(
	(await pool.run("increment", [3])) === 3 && (await pool.run("increment", [4])) === 7,
	"persistent isolated state",
);
const input = new Uint8Array([5]);
const moved = pool.run("buffer", [input], { transfer: [input.buffer] });
check(input.buffer.byteLength === 0, "queued transfer commits synchronously");
check((await moved)[0] === 6, "result transfer");
const poolChannel = new MessageChannel();
const poolPort = await pool.run("port", [poolChannel.port2], {
	transfer: [poolChannel.port2],
});
const poolReply = message(poolChannel.port1);
poolChannel.port1.start();
poolPort.postMessage(23);
check(
	(await poolReply) === 23,
	"pool forwards transferable endpoints through queued admission",
);
poolPort.close();
poolChannel.port1.close();
const started = new Int32Array(new SharedArrayBuffer(4));
const controller = new AbortController();
const spinning = pool.run("spin", [started], { signal: controller.signal });
const observedSpin = spinning.catch((error) => error);
while (Atomics.load(started, 0) === 0)
	await new Promise((resolve) => setTimeout(resolve, 1));
const queuedController = new AbortController();
const queued = pool.run("increment", [100], { signal: queuedController.signal });
const observedQueue = queued.catch((error) => error);
queuedController.abort();
controller.abort();
check(
	(await observedQueue).name === "AbortError" &&
		(await observedSpin).name === "AbortError",
	"queued and CPU cancellation",
);
check((await pool.run("increment", [1])) === 8, "cancelled job never executes");
const invalidSignalBuffer = new ArrayBuffer(4);
let invalidSignal;
try {
	pool.run("buffer", [new Uint8Array(invalidSignalBuffer)], {
		signal: {},
		transfer: [invalidSignalBuffer],
	});
} catch (error) {
	invalidSignal = error;
}
check(
	invalidSignal instanceof TypeError && invalidSignalBuffer.byteLength === 4,
	"invalid signal fails before transfer",
);
const asyncStarted = new Int32Array(new SharedArrayBuffer(4));
const asyncController = new AbortController();
const asyncCancelled = pool
	.run("awaitCancellation", [asyncStarted], { signal: asyncController.signal })
	.catch((error) => error);
while (Atomics.load(asyncStarted, 0) === 0)
	await new Promise((resolve) => setTimeout(resolve, 1));
asyncController.abort();
check(
	(await asyncCancelled).name === "AbortError",
	"async task receives abort through independent notification",
);
check(
	(await pool.run("sum", [[1, 2]])) === 3,
	"executor recovers after async cancellation",
);
const cloneFailure = await pool.run("uncloneableFailure").catch((error) => error);
check(
	cloneFailure instanceof Error &&
		cloneFailure.message === "Worker task failed with an uncloneable value",
	"uncloneable task errors settle",
);
const results = [];
for await (const result of pool.map("sum", [[[1, 2]], [[3, 4]], [[5, 6]]], { window: 2 }))
	results.push(result);
check(JSON.stringify(results) === "[3,7,11]", "bounded ordered map");
let inputClosed = false;
function* inputs() {
	try {
		yield [[2, 3]];
		yield [[5, 6]];
	} finally {
		inputClosed = true;
	}
}
for await (const value of pool.map("sum", inputs(), { window: 1 })) {
	check(value === 5, "map first result");
	break;
}
check(inputClosed, "early map return closes input");
const zeroQueue = createPool(jobs, { size: 1, maxQueuedTasks: 0 });
await zeroQueue.ready;
let recursiveError;
const recursiveArgs = [0];
Object.defineProperty(recursiveArgs, "0", {
	enumerable: true,
	get() {
		try {
			zeroQueue.run("increment", [100]);
		} catch (error) {
			recursiveError = error;
		}
		return 1;
	},
});
check(
	(await zeroQueue.run("increment", recursiveArgs)) === 1 &&
		recursiveError.name === "QueueFullError",
	"reentrant getters reserve task capacity",
);
await zeroQueue.close();

for (const closeDuring of ["signal", "transfer", "iterator"]) {
	const closingPool = createPool(jobs, { size: 1 });
	await closingPool.ready;
	const buffer = new ArrayBuffer(8);
	const options = {};
	if (closeDuring === "signal") {
		Object.defineProperty(options, "signal", {
			get() {
				closingPool.terminate();
				return undefined;
			},
		});
		options.transfer = [buffer];
	} else if (closeDuring === "transfer") {
		Object.defineProperty(options, "transfer", {
			get() {
				closingPool.close();
				return [buffer];
			},
		});
	} else {
		options.transfer = {
			*[Symbol.iterator]() {
				closingPool.close();
				yield buffer;
			},
		};
	}
	let rejected;
	try {
		closingPool.run("sum", [[1, 2]], options);
	} catch (error) {
		rejected = error;
	}
	check(
		rejected?.name === "InvalidStateError" && buffer.byteLength === 8,
		`closing during ${closeDuring} preserves submission ownership`,
	);
	await closingPool.close();
}

const abortBeforeAdmission = new AbortController();
const abortedBuffer = new ArrayBuffer(8);
let abortedSubmission;
try {
	pool.run("sum", [[1, 2]], {
		signal: abortBeforeAdmission.signal,
		get transfer() {
			abortBeforeAdmission.abort();
			return [abortedBuffer];
		},
	});
} catch (error) {
	abortedSubmission = error;
}
check(
	abortedSubmission?.name === "AbortError" && abortedBuffer.byteLength === 8,
	"abort during transfer options fails before native admission",
);
await pool.close();
check(pool.stats().active === 0 && pool.stats().queued === 0, "drained close");
console.log("workers PASS");
