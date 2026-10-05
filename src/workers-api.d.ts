// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Parallel computation and isolated event loops. Declared entries are bundled into
 * the application image; workers do not compile or load source files at runtime.
 * Native executors and GC helpers are shared across JavaScript isolates.
 */
declare module "maligator:workers" {
	/**
	 * An immutable image-local worker entry declaration. The compiler resolves the
	 * declaration independently of how libraries pass the descriptor or its href onward.
	 * Erased module types express the caller's assertion; runtime entry identity is
	 * validated.
	 *
	 * @see https://maligator.ddv.tools/api/workers#WorkerUrl
	 */
	export type WorkerUrl<Module = unknown> = {
		readonly href: string;
		readonly __workerModule?: Module;
	};

	/**
	 * ArrayBuffer stores move at admission. MessagePort endpoints transfer ownership.
	 * SharedArrayBuffer is cloned by sharing its backing and cannot be transferred.
	 *
	 * @see https://maligator.ddv.tools/api/workers#Transferable
	 */
	export type Transferable = ArrayBuffer | MessagePort;

	/**
	 * Cancellation is cooperative while a pool task runs. The worker remains occupied
	 * until the task's returned promise settles.
	 *
	 * @see https://maligator.ddv.tools/api/workers#TaskContext
	 */
	export type TaskContext = {
		/** Worker-local cancellation signal. Cancellation does not preempt JavaScript. */
		readonly signal: AbortSignal;
		/** Throws if cancelled. Check between bounded pieces of work. */
		throwIfCancelled(): void;
	};

	/**
	 * An opaque result envelope. Constructing it does not detach buffers; publication
	 * commits transfers.
	 *
	 * @see https://maligator.ddv.tools/api/workers#TransferResult
	 */
	export type TransferResult<Value> = {
		readonly value: Value;
		readonly __transferResult: unique symbol;
	};

	/**
	 * Names of context-first exported task functions.
	 *
	 * @see https://maligator.ddv.tools/api/workers#TaskNames
	 */
	export type TaskNames<Module> = {
		[Key in keyof Module]-?: Module[Key] extends (
			context: TaskContext,
			...args: infer Args
		) => unknown
			? Key
			: never;
	}[keyof Module] &
		string;

	/**
	 * The task's argument tuple, excluding its local cancellation context.
	 *
	 * @see https://maligator.ddv.tools/api/workers#TaskArgs
	 */
	export type TaskArgs<Function> = Function extends (
		context: TaskContext,
		...args: infer Args
	) => unknown
		? Args
		: never;

	/**
	 * The settled task result after unwrapping an explicit transfer envelope.
	 *
	 * @see https://maligator.ddv.tools/api/workers#TaskValue
	 */
	export type TaskValue<Function> = Function extends (
		...args: Array<never>
	) => infer Result
		? Awaited<Result> extends TransferResult<infer Value>
			? Value
			: Awaited<Result>
		: never;

	/**
	 * Fixed persistent worker count and admission bounds. Every worker has independent
	 * module state. A size-one pool dispatches admitted tasks serially.
	 *
	 * @see https://maligator.ddv.tools/api/workers#PoolOptions
	 */
	export type PoolOptions = {
		/** Positive safe integer; defaults to host parallelism, falling back to 1. */
		size?: number;
		/** Nonnegative safe integer; defaults to four times size. Zero disables the waiting queue. */
		maxQueuedTasks?: number;
		/** Positive safe integer in bytes; defaults to 67108864 (64 MiB). */
		maxQueuedBytes?: number;
		/** Positive safe integer in bytes; defaults to maxQueuedBytes. */
		maxMessageBytes?: number;
		/** Worker name prefix; each worker receives a one-based suffix. */
		name?: string;
	};

	/**
	 * The transfer list commits synchronously when run returns normally. Validation,
	 * saturation, closed pools and already-aborted signals throw before admission.
	 *
	 * @see https://maligator.ddv.tools/api/workers#RunOptions
	 */
	export type RunOptions = {
		/** Already-aborted signals throw before admission. Running cancellation is cooperative. */
		signal?: AbortSignal;
		/** Ownership moves synchronously on successful admission; rejection leaves values unchanged. */
		transfer?: ReadonlyArray<Transferable>;
	};

	/**
	 * The window bounds pulled inputs and buffered results together. Results are yielded
	 * in input order; iterator return cancels this map's work and closes its input.
	 *
	 * @see https://maligator.ddv.tools/api/workers#MapOptions
	 */
	export type MapOptions<Args> = {
		/** Cancels only work owned by this map; running tasks must cooperate. */
		signal?: AbortSignal;
		/** Positive safe integer; defaults to pool size. Bounds pulled inputs and buffered results together. */
		window?: number;
		/** Called for each input before admission to choose values whose ownership moves. */
		transfer?: (args: Args, index: number) => ReadonlyArray<Transferable>;
	};

	/**
	 * A snapshot of this pool's scheduling and settled operations.
	 *
	 * @see https://maligator.ddv.tools/api/workers#PoolStats
	 */
	export type PoolStats = {
		readonly size: number;
		readonly active: number;
		readonly queued: number;
		readonly completed: number;
		readonly failed: number;
		readonly cancelled: number;
	};

	/**
	 * A bounded task scheduler over isolated persistent workers. Each worker executes
	 * one task through asynchronous settlement. No accepted task is replayed after
	 * worker failure.
	 *
	 * @see https://maligator.ddv.tools/api/workers#WorkerPool
	 */
	export type WorkerPool<Module> = {
		/** Resolves after every worker evaluates the entry; rejects on startup failure. */
		readonly ready: Promise<void>;
		/** Throws on failed admission; returns a promise for the accepted task's result or failure. */
		run<Key extends TaskNames<Module>>(
			name: Key,
			args: TaskArgs<Module[Key]>,
			options?: RunOptions,
		): Promise<TaskValue<Module[Key]>>;
		/** Yields in input order. Returning from the iterator cancels its work and closes its input. */
		map<Key extends TaskNames<Module>>(
			name: Key,
			args: Iterable<TaskArgs<Module[Key]>> | AsyncIterable<TaskArgs<Module[Key]>>,
			options?: MapOptions<TaskArgs<Module[Key]>>,
		): AsyncIterable<TaskValue<Module[Key]>>;
		/** Stops admission, drains accepted tasks, then joins every worker. Idempotent. */
		close(): Promise<void>;
		/** Rejects outstanding tasks with AbortError; joins workers after running tasks cooperate and settle. */
		terminate(): Promise<void>;
		/** Returns a scheduling snapshot; counts are not a subscription. */
		stats(): PoolStats;
		/** Keeps the process alive while pool workers exist; returns this pool. */
		ref(): WorkerPool<Module>;
		/** Allows the process to exit without waiting for this pool; returns this pool. */
		unref(): WorkerPool<Module>;
		/** Reports whether this pool currently keeps the process alive. */
		hasRef(): boolean;
	};

	/**
	 * A terminal record published only after the native worker is joined and its slot is
	 * released.
	 *
	 * @see https://maligator.ddv.tools/api/workers#WorkerExit
	 */
	export type WorkerExit = {
		readonly id: number;
		readonly code: number;
		readonly reason: "completed" | "terminated" | "error";
		readonly error?: unknown;
	};

	/**
	 * Worker data is snapshotted before startup. The native host bounds live workers and
	 * message admission process-wide.
	 *
	 * @see https://maligator.ddv.tools/api/workers#WorkerOptions
	 */
	export type WorkerOptions = {
		name?: string;
		/** Cloned into workerData before startup; later caller mutations are not shared. */
		data?: unknown;
		/** Values moved as part of startup-data admission. */
		transfer?: ReadonlyArray<Transferable>;
		/** Positive safe integer, at most 4294967295; defaults to 4096 messages per endpoint. */
		maxQueuedMessages?: number;
		/** Positive safe integer in bytes; defaults to 67108864 (64 MiB) per endpoint. */
		maxQueuedBytes?: number;
		/** Positive safe integer in bytes; defaults to 16777216 (16 MiB) per message. */
		maxMessageBytes?: number;
	};

	/**
	 * Each endpoint bounds its pending message count and bytes. Rejection leaves the
	 * sender's transferables unchanged.
	 *
	 * @see https://maligator.ddv.tools/api/workers#MessageChannelOptions
	 */
	export type MessageChannelOptions = {
		/** Positive safe integer, at most 4294967295; defaults to 4096 messages per endpoint. */
		maxQueuedMessages?: number;
		/** Positive safe integer in bytes; defaults to 67108864 (64 MiB) per endpoint. */
		maxQueuedBytes?: number;
		/** Positive safe integer in bytes; defaults to 16777216 (16 MiB) per message. */
		maxMessageBytes?: number;
	};

	/**
	 * An ordered bidirectional endpoint with transactional transfer and bounded queues.
	 * Message listeners and values are owned by the receiving isolate.
	 *
	 * @see https://maligator.ddv.tools/api/workers#MessagePort.type
	 */
	export interface MessagePort<Send = unknown, Receive = unknown> extends EventTarget {
		/** Clones and admits a message synchronously. Transfer commits only after successful validation/admission. */
		postMessage(value: Send, transfer?: ReadonlyArray<Transferable>): void;
		/** Setting this handler starts delivery. addEventListener listeners need start(). */
		onmessage: ((event: MessageEvent<Receive>) => void) | null;
		/** Receives message decoding failures in the receiving isolate. */
		onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
		/** Enables delivery to event listeners; repeated calls are harmless. */
		start(): void;
		/** Discards queued messages and closes this endpoint. */
		close(): void;
		/** Keeps the receiving isolate alive; returns this port. */
		ref(): MessagePort<Send, Receive>;
		/** Allows the receiving isolate to exit; returns this port. */
		unref(): MessagePort<Send, Receive>;
		hasRef(): boolean;
	}

	/**
	 * A standalone channel whose endpoints may be transferred to workers.
	 *
	 * @see https://maligator.ddv.tools/api/workers#MessageChannel.type
	 */
	export type MessageChannel = {
		readonly port1: MessagePort;
		readonly port2: MessagePort;
	};

	/**
	 * A long-lived isolated module and its parent communication port. Startup completes
	 * after module evaluation; shutdown completes after native thread reaping.
	 *
	 * @see https://maligator.ddv.tools/api/workers#Worker.type
	 */
	export type Worker<Send = unknown, Receive = unknown> = EventTarget & {
		readonly id: number;
		/** Resolves after entry evaluation; rejects on startup failure. */
		readonly ready: Promise<void>;
		/** Resolves with a terminal record after the native thread is joined and its slot released. */
		readonly closed: Promise<WorkerExit>;
		readonly port: MessagePort<Send, Receive>;
		/** Requests shutdown and resolves after thread reaping. */
		terminate(): Promise<WorkerExit>;
		ref(): Worker<Send, Receive>;
		unref(): Worker<Send, Receive>;
		hasRef(): boolean;
	};

	/**
	 * Declare an entry using a static string literal and explicit import.meta.url base.
	 * The immutable href projection can be passed to existing worker libraries.
	 *
	 * @example
	 * // declaration.ts
	 * import { createWorkerUrl } from "maligator:workers";
	 *
	 * export const tasks = createWorkerUrl<typeof import("./sum.ts")>(
	 * 	"./sum.ts",
	 * 	import.meta.url,
	 * );
	 *
	 * console.log(Object.isFrozen(tasks), tasks.href.startsWith("file:"));
	 *
	 * @see https://maligator.ddv.tools/api/workers#createWorkerUrl
	 */
	export const createWorkerUrl: <Module = unknown>(
		specifier: string,
		base: string,
	) => WorkerUrl<Module>;
	/**
	 * Create a bounded pool of persistent workers for a declared entry. Submission
	 * failures throw synchronously; admitted tasks settle asynchronously. Await ready
	 * before submitting startup-dependent work and close the pool when finished. Throws
	 * NotSupportedError without threads and RangeError for invalid bounds.
	 *
	 * @see https://maligator.ddv.tools/api/workers#createPool
	 */
	export const createPool: <Module>(
		entry: WorkerUrl<Module>,
		options?: PoolOptions,
	) => WorkerPool<Module>;
	/**
	 * Wrap a result for transfer when the worker publishes it.
	 *
	 * @example
	 * // transfer-task.ts
	 * import { transfer } from "maligator:workers";
	 * import type { TaskContext } from "maligator:workers";
	 *
	 * export function reverse(context: TaskContext, buffer: ArrayBuffer) {
	 * 	context.throwIfCancelled();
	 * 	new Uint8Array(buffer).reverse();
	 * 	return transfer(buffer, [buffer]);
	 * }
	 *
	 * @see https://maligator.ddv.tools/api/workers#transfer
	 */
	export const transfer: <Value>(
		value: Value,
		transfer: ReadonlyArray<Transferable>,
	) => TransferResult<Value>;
	/**
	 * Start a declared isolated module and expose its ordered port and complete
	 * lifecycle.
	 *
	 * @example
	 * // echo.ts
	 * import { parentPort } from "maligator:workers";
	 *
	 * if (parentPort === null) throw new Error("Run this module as a worker");
	 * const port = parentPort;
	 * port.onmessage = (event) => {
	 * 	port.postMessage(String(event.data));
	 * };
	 * port.start();
	 *
	 * @see https://maligator.ddv.tools/api/workers#Worker
	 */
	export const Worker: {
		new <Send = unknown, Receive = unknown>(
			entry: WorkerUrl,
			options?: WorkerOptions,
		): Worker<Send, Receive>;
	};
	/**
	 * Create two transferable endpoints independently of worker startup.
	 *
	 * @see https://maligator.ddv.tools/api/workers#MessageChannel
	 */
	export const MessageChannel: { new (options?: MessageChannelOptions): MessageChannel };
	/**
	 * The port prototype for type and identity checks. Ports are created by channels and
	 * workers.
	 *
	 * @see https://maligator.ddv.tools/api/workers#MessagePort
	 */
	export const MessagePort: { readonly prototype: MessagePort };
	/**
	 * Synchronously dequeue one pending message without running unrelated callbacks.
	 *
	 * @see https://maligator.ddv.tools/api/workers#receiveMessageOnPort
	 */
	export const receiveMessageOnPort: <Receive>(
		port: MessagePort<unknown, Receive>,
	) => { message: Receive } | undefined;
	/**
	 * Report the running host's worker facilities and capacity.
	 *
	 * @example
	 * // capabilities.ts
	 * import { capabilities } from "maligator:workers";
	 *
	 * const host = capabilities();
	 * console.log(host.threads, host.sharedMemory);
	 * console.log(host.parallelism >= 1, host.maxWorkers >= 1);
	 *
	 * @see https://maligator.ddv.tools/api/workers#capabilities
	 */
	export const capabilities: () => {
		readonly threads: boolean;
		readonly sharedMemory: boolean;
		readonly parallelism: number;
		readonly maxWorkers: number;
	};
	/**
	 * The worker's parent endpoint; null in the main isolate.
	 *
	 * @example
	 * // echo.ts
	 * import { parentPort } from "maligator:workers";
	 *
	 * if (parentPort === null) throw new Error("Run this module as a worker");
	 * const port = parentPort;
	 * port.onmessage = (event) => {
	 * 	port.postMessage(String(event.data));
	 * };
	 * port.start();
	 *
	 * @see https://maligator.ddv.tools/api/workers#parentPort
	 */
	export const parentPort: MessagePort | null;
	/**
	 * The worker-owned clone of startup data.
	 *
	 * @example
	 * // configuration.ts
	 * import { createWorkerUrl, Worker } from "maligator:workers";
	 *
	 * const entry = createWorkerUrl("./worker-data.ts", import.meta.url);
	 * const worker = new Worker(entry, { data: { label: "thumbnail" } });
	 * try {
	 * 	await worker.ready;
	 * 	const exit = await worker.closed;
	 * 	if (exit.code !== 0) throw new Error("Worker failed");
	 * } finally {
	 * 	await worker.terminate();
	 * }
	 *
	 * @see https://maligator.ddv.tools/api/workers#workerData
	 */
	export const workerData: unknown;
}
