import {
	Worker,
	MessageChannel,
	MessagePort,
	receiveMessageOnPort,
	capabilities,
	createWorkerUrl,
	parentPort,
	workerData,
	poolEntry,
} from "maligator:internal/workers";

export {
	Worker,
	MessageChannel,
	MessagePort,
	receiveMessageOnPort,
	capabilities,
	createWorkerUrl,
	parentPort,
	workerData,
};

export { transfer } from "./transfer.mjs";

const signalAborted = Object.getOwnPropertyDescriptor(
	AbortSignal.prototype,
	"aborted",
).get;
const signalReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason").get;
const addAbortListener = EventTarget.prototype.addEventListener;
const removeAbortListener = EventTarget.prototype.removeEventListener;

function positiveInteger(value, fallback, name, allowZero = false) {
	const result = value === undefined ? fallback : value;
	if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1)) {
		throw new RangeError(
			`${name} must be ${allowZero ? "a nonnegative" : "a positive"} safe integer`,
		);
	}
	return result;
}

function namedError(name, message) {
	const error = new Error(message);
	error.name = name;
	return error;
}

function abortReason(signal) {
	const reason = signalReason.call(signal);
	return reason === undefined
		? namedError("AbortError", "Worker task was cancelled")
		: reason;
}

export function createPool(entry, options = {}) {
	const available = capabilities();
	if (!available.threads)
		throw namedError("NotSupportedError", "Workers require a threaded host");
	const size = positiveInteger(options.size, available.parallelism ?? 1, "size");
	const maxQueuedTasks = positiveInteger(
		options.maxQueuedTasks,
		size * 4,
		"maxQueuedTasks",
		true,
	);
	const maxQueuedBytes = positiveInteger(
		options.maxQueuedBytes,
		64 * 1024 * 1024,
		"maxQueuedBytes",
	);
	const maxMessageBytes = positiveInteger(
		options.maxMessageBytes,
		maxQueuedBytes,
		"maxMessageBytes",
	);
	const queue = new MessageChannel({
		maxQueuedMessages: maxQueuedTasks + size,
		maxQueuedBytes,
		maxMessageBytes,
	});
	queue.port1.unref();
	queue.port2.unref();
	const jobs = new Map();
	const workers = [];
	let state = "open";
	let ready = false;
	let nextId = 1;
	let queued = 0;
	let admitting = 0;
	let active = 0;
	let completed = 0;
	let failed = 0;
	let cancelled = 0;
	let referenced = true;
	let shutdown;
	let shutdownResolve;
	let shutdownReject;
	let shuttingDown = false;

	function updateReferences() {
		for (const worker of workers) {
			if (referenced && (!ready || jobs.size > 0)) worker.handle.ref();
			else worker.handle.unref();
		}
	}

	function detachAbort(job) {
		if (job.signal !== undefined)
			removeAbortListener.call(job.signal, "abort", job.abort);
	}

	function settle(job, ok, value) {
		if (job.settled) return;
		job.settled = true;
		detachAbort(job);
		if (ok) job.resolve(value);
		else job.reject(value);
	}

	function shutdownPromise() {
		if (shutdown === undefined) {
			shutdown = new Promise((resolve, reject) => {
				shutdownResolve = resolve;
				shutdownReject = reject;
			});
			shutdown.catch(() => {});
		}
		return shutdown;
	}

	function finishShutdown() {
		if (
			shuttingDown ||
			(state !== "closing" && state !== "terminating") ||
			jobs.size !== 0
		)
			return;
		shuttingDown = true;
		queue.port1.close();
		queue.port2.close();
		Promise.all(workers.map((worker) => worker.handle.terminate())).then(
			() => {
				state = "closed";
				shutdownResolve();
			},
			(error) => {
				state = "closed";
				shutdownReject(error);
			},
		);
	}

	function failPool(error) {
		if (state === "closed" || state === "terminating") return;
		state = "terminating";
		shutdownPromise();
		// A failed worker may have changed persistent module state; accepted tasks are never replayed.
		for (const job of jobs.values()) {
			Atomics.store(job.flag, 0, 1);
			Atomics.notify(job.flag, 0);
			if (!job.settled) {
				failed++;
				settle(job, false, error);
			}
		}
		jobs.clear();
		queued = 0;
		active = 0;
		updateReferences();
		finishShutdown();
	}

	function dispatch() {
		if (!ready || state === "terminating" || state === "closed") return;
		for (const worker of workers) {
			if (worker.job !== undefined) continue;
			for (;;) {
				const envelope = receiveMessageOnPort(queue.port2);
				if (envelope === undefined) break;
				const request = envelope.message;
				const job = jobs.get(request.id);
				if (job === undefined) continue;
				queued--;
				active++;
				worker.job = job;
				job.worker = worker;
				try {
					worker.handle.port.postMessage(request, request.transfer);
				} catch (error) {
					worker.job = undefined;
					active--;
					jobs.delete(job.id);
					failed++;
					settle(job, false, error);
					continue;
				}
				break;
			}
		}
		updateReferences();
		finishShutdown();
	}

	function onResponse(worker, response) {
		const job = worker.job;
		if (job === undefined || response.id !== job.id) return;
		worker.job = undefined;
		active--;
		jobs.delete(job.id);
		if (!job.settled) {
			if (response.ok) completed++;
			else failed++;
			settle(job, response.ok, response.value);
		}
		dispatch();
	}

	try {
		for (let index = 0; index < size; index++) {
			const handle = new Worker(poolEntry, {
				name: options.name === undefined ? undefined : `${options.name}-${index + 1}`,
				data: { entry },
				maxQueuedMessages: 2,
				maxQueuedBytes,
				maxMessageBytes,
			});
			const worker = { handle, job: undefined };
			workers.push(worker);
			handle.port.addEventListener("message", (event) => onResponse(worker, event.data));
			handle.port.start();
			handle.addEventListener("error", (event) =>
				failPool(
					event.error ?? namedError("WorkerError", event.message ?? "Worker failed"),
				),
			);
			handle.closed.then((exit) => {
				if (!shuttingDown && state !== "closed")
					failPool(
						exit.error ??
							namedError("WorkerError", `Worker exited with code ${exit.code}`),
					);
			}, failPool);
		}
	} catch (error) {
		queue.port1.close();
		queue.port2.close();
		for (const worker of workers) worker.handle.terminate();
		throw error;
	}

	const readyPromise = Promise.all(workers.map((worker) => worker.handle.ready)).then(
		() => {
			ready = true;
			dispatch();
		},
		(error) => {
			failPool(error);
			throw error;
		},
	);
	readyPromise.catch(() => {});

	function run(name, args = [], runOptions = {}) {
		if (state !== "open") throw namedError("InvalidStateError", "Worker pool is closed");
		if (typeof name !== "string" || !Array.isArray(args))
			throw new TypeError("run requires an export name and an argument array");
		if (jobs.size + admitting >= maxQueuedTasks + (ready ? size : 0)) {
			throw namedError("QueueFullError", "Worker pool queue is full");
		}
		// Clone getters can submit recursively before the outer snapshot commits.
		admitting++;
		try {
			return submit(name, args, runOptions);
		} finally {
			admitting--;
		}
	}

	function submit(name, args, runOptions) {
		const signal = runOptions.signal;
		if (signal !== undefined && signalAborted.call(signal)) throw abortReason(signal);
		const flag = new Int32Array(new SharedArrayBuffer(4));
		if (nextId > Number.MAX_SAFE_INTEGER)
			throw new RangeError("Worker task identifiers are exhausted");
		const id = nextId++;
		let resolve;
		let reject;
		const result = new Promise((resolveResult, rejectResult) => {
			resolve = resolveResult;
			reject = rejectResult;
		});
		const job = {
			id,
			flag,
			resolve,
			reject,
			signal,
			settled: false,
			admitted: false,
			worker: undefined,
			abort: undefined,
			ticket: undefined,
		};
		job.abort = () => {
			if (job.settled) return;
			Atomics.store(flag, 0, 1);
			Atomics.notify(flag, 0);
			if (!job.admitted) return;
			cancelled++;
			settle(job, false, abortReason(signal));
			if (job.worker === undefined) {
				queue.port1._discard(job.ticket);
				jobs.delete(id);
				queued--;
			}
			dispatch();
		};
		// This local mailbox owns the admitted snapshot even while every executor is busy.
		if (signal !== undefined)
			addAbortListener.call(signal, "abort", job.abort, { once: true });
		try {
			const transferList = Object.freeze(Array.from(runOptions.transfer ?? []));
			if (state !== "open")
				throw namedError("InvalidStateError", "Worker pool is closed");
			if (signal !== undefined && signalAborted.call(signal)) throw abortReason(signal);
			job.ticket = queue.port1.postMessage(
				{ id, name, args, flag, transfer: transferList },
				transferList,
			);
			if (job.ticket === undefined)
				throw namedError("InvalidStateError", "Worker pool is closed");
		} catch (error) {
			detachAbort(job);
			throw error;
		}
		jobs.set(id, job);
		job.admitted = true;
		queued++;
		if (signal !== undefined && signalAborted.call(signal)) job.abort();
		dispatch();
		return result;
	}

	async function* map(name, inputs, mapOptions = {}) {
		const window = positiveInteger(mapOptions.window, size, "window");
		const controller = new AbortController();
		const signal = mapOptions.signal;
		const abort = () => controller.abort(signalReason.call(signal));
		if (signal !== undefined) {
			if (signalAborted.call(signal)) abort();
			else addAbortListener.call(signal, "abort", abort, { once: true });
		}
		const iterator = inputs[Symbol.asyncIterator]?.() ?? inputs[Symbol.iterator]();
		const pending = [];
		let exhausted = false;
		let inputIndex = 0;
		try {
			while (!exhausted || pending.length > 0) {
				while (!exhausted && pending.length < window) {
					const item = await iterator.next();
					exhausted = item.done === true;
					if (exhausted) break;
					const result = run(name, item.value, {
						signal: controller.signal,
						transfer: mapOptions.transfer?.(item.value, inputIndex++) ?? [],
					});
					// Observe every rejection immediately while preserving ordered yields.
					pending.push(
						result.then(
							(value) => ({ ok: true, value }),
							(value) => ({ ok: false, value }),
						),
					);
				}
				if (pending.length > 0) {
					const result = await pending.shift();
					if (!result.ok) throw result.value;
					yield result.value;
				}
			}
		} finally {
			controller.abort();
			if (signal !== undefined) removeAbortListener.call(signal, "abort", abort);
			if (!exhausted && iterator.return !== undefined) await iterator.return();
		}
	}

	return Object.freeze({
		ready: readyPromise,
		run,
		map,
		close() {
			const result = shutdownPromise();
			if (state === "open") state = "closing";
			finishShutdown();
			return result;
		},
		terminate() {
			const result = shutdownPromise();
			if (state !== "closed" && state !== "terminating") {
				state = "terminating";
				for (const job of jobs.values()) {
					Atomics.store(job.flag, 0, 1);
					Atomics.notify(job.flag, 0);
					if (!job.settled) {
						cancelled++;
						settle(job, false, namedError("AbortError", "Worker pool was terminated"));
					}
				}
				jobs.clear();
				queued = 0;
				active = 0;
				updateReferences();
				finishShutdown();
			}
			return result;
		},
		stats() {
			return { size, active, queued, completed, failed, cancelled };
		},
		ref() {
			referenced = true;
			updateReferences();
			return this;
		},
		unref() {
			referenced = false;
			updateReferences();
			return this;
		},
		hasRef() {
			return referenced;
		},
	});
}
