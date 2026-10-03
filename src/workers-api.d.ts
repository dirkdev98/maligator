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
	 */
	export type WorkerUrl<Module = unknown> = {
		readonly href: string;
		readonly __workerModule?: Module;
	};

	/**
	 * ArrayBuffer stores move at admission. MessagePort endpoints transfer ownership.
	 * SharedArrayBuffer is cloned by sharing its backing and cannot be transferred.
	 */
	export type Transferable = ArrayBuffer | MessagePort;

	/**
	 * Cancellation is cooperative while a pool task runs. The worker remains occupied
	 * until the task's returned promise settles.
	 */
	export type TaskContext = { readonly signal: AbortSignal; throwIfCancelled(): void };

	/**
	 * An opaque result envelope. Constructing it does not detach buffers; publication
	 * commits transfers.
	 */
	export type TransferResult<Value> = {
		readonly value: Value;
		readonly __transferResult: unique symbol;
	};

	/**
	 * Names of context-first exported task functions.
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
	 */
	export type TaskArgs<Function> = Function extends (
		context: TaskContext,
		...args: infer Args
	) => unknown
		? Args
		: never;

	/**
	 * The settled task result after unwrapping an explicit transfer envelope.
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
	 */
	export type PoolOptions = {
		size?: number;
		maxQueuedTasks?: number;
		maxQueuedBytes?: number;
		maxMessageBytes?: number;
		name?: string;
	};

	/**
	 * The transfer list commits synchronously when run returns normally. Validation,
	 * saturation, closed pools and already-aborted signals throw before admission.
	 */
	export type RunOptions = {
		signal?: AbortSignal;
		transfer?: ReadonlyArray<Transferable>;
	};

	/**
	 * The window bounds pulled inputs and buffered results together. Results are yielded
	 * in input order; iterator return cancels this map's work and closes its input.
	 */
	export type MapOptions<Args> = {
		signal?: AbortSignal;
		window?: number;
		transfer?: (args: Args, index: number) => ReadonlyArray<Transferable>;
	};

	/**
	 * A snapshot of this pool's scheduling and settled operations.
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
	 */
	export type WorkerPool<Module> = {
		readonly ready: Promise<void>;
		run<Key extends TaskNames<Module>>(
			name: Key,
			args: TaskArgs<Module[Key]>,
			options?: RunOptions,
		): Promise<TaskValue<Module[Key]>>;
		map<Key extends TaskNames<Module>>(
			name: Key,
			args: Iterable<TaskArgs<Module[Key]>> | AsyncIterable<TaskArgs<Module[Key]>>,
			options?: MapOptions<TaskArgs<Module[Key]>>,
		): AsyncIterable<TaskValue<Module[Key]>>;
		close(): Promise<void>;
		terminate(): Promise<void>;
		stats(): PoolStats;
		ref(): WorkerPool<Module>;
		unref(): WorkerPool<Module>;
		hasRef(): boolean;
	};

	/**
	 * A terminal record published only after the native worker is joined and its slot is
	 * released.
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
	 */
	export type WorkerOptions = {
		name?: string;
		data?: unknown;
		transfer?: ReadonlyArray<Transferable>;
		maxQueuedMessages?: number;
		maxQueuedBytes?: number;
		maxMessageBytes?: number;
	};

	/**
	 * Each endpoint bounds its pending message count and bytes. Rejection leaves the
	 * sender's transferables unchanged.
	 */
	export type MessageChannelOptions = {
		maxQueuedMessages?: number;
		maxQueuedBytes?: number;
		maxMessageBytes?: number;
	};

	/**
	 * An ordered bidirectional endpoint with transactional transfer and bounded queues.
	 * Message listeners and values are owned by the receiving isolate.
	 */
	export interface MessagePort<Send = unknown, Receive = unknown> extends EventTarget {
		postMessage(value: Send, transfer?: ReadonlyArray<Transferable>): void;
		onmessage: ((event: MessageEvent<Receive>) => void) | null;
		onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
		start(): void;
		close(): void;
		ref(): MessagePort<Send, Receive>;
		unref(): MessagePort<Send, Receive>;
		hasRef(): boolean;
	}

	/**
	 * A standalone channel whose endpoints may be transferred to workers.
	 */
	export type MessageChannel = {
		readonly port1: MessagePort;
		readonly port2: MessagePort;
	};

	/**
	 * A long-lived isolated module and its parent communication port. Startup completes
	 * after module evaluation; shutdown completes after native thread reaping.
	 */
	export type Worker<Send = unknown, Receive = unknown> = EventTarget & {
		readonly id: number;
		readonly ready: Promise<void>;
		readonly closed: Promise<WorkerExit>;
		readonly port: MessagePort<Send, Receive>;
		terminate(): Promise<WorkerExit>;
		ref(): Worker<Send, Receive>;
		unref(): Worker<Send, Receive>;
		hasRef(): boolean;
	};

	/**
	 * Declare an entry using a statically resolved module specifier and explicit
	 * import.meta.url base. The immutable href projection can be passed to existing
	 * worker libraries.
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
	 * @example
	 * // sum.ts
	 * import type { TaskContext } from "maligator:workers";
	 *
	 * export function sum(context: TaskContext, values: Array<number>): number {
	 * 	context.throwIfCancelled();
	 * 	return values.reduce((total, value) => total + value, 0);
	 * }
	 */
	export const createWorkerUrl: <Module = unknown>(
		specifier: string,
		base: string,
	) => WorkerUrl<Module>;
	/**
	 * Create a persistent bounded pool. Submission failures throw synchronously; an
	 * admitted task settles asynchronously.
	 *
	 * @example
	 * // pool.ts
	 * import { createPool, createWorkerUrl } from "maligator:workers";
	 *
	 * const tasks = createWorkerUrl<typeof import("./tasks.ts")>(
	 * 	"./tasks.ts",
	 * 	import.meta.url,
	 * );
	 * const pool = createPool(tasks, { size: 2, maxQueuedTasks: 4 });
	 *
	 * try {
	 * 	await pool.ready;
	 * 	console.log(await pool.run("sum", [[1, 2, 3]]));
	 *
	 * 	const inputs: Array<[Array<number>]> = [[[1, 2]], [[3, 4]]];
	 * 	for await (const total of pool.map("sum", inputs, { window: 2 })) {
	 * 		console.log(total);
	 * 	}
	 *
	 * 	const controller = new AbortController();
	 * 	const pending = pool.run("waitForCancellation", [], {
	 * 		signal: controller.signal,
	 * 	});
	 * 	const cancelled = pending.then(
	 * 		() => false,
	 * 		(reason: unknown) => reason === controller.signal.reason,
	 * 	);
	 * 	controller.abort();
	 * 	console.log(await cancelled);
	 * } finally {
	 * 	await pool.close();
	 * }
	 *
	 * @example
	 * // tasks.ts
	 * import type { TaskContext } from "maligator:workers";
	 *
	 * export function sum(context: TaskContext, values: Array<number>): number {
	 * 	let total = 0;
	 * 	for (const value of values) {
	 * 		context.throwIfCancelled();
	 * 		total += value;
	 * 	}
	 * 	return total;
	 * }
	 *
	 * export async function waitForCancellation(context: TaskContext): Promise<void> {
	 * 	context.throwIfCancelled();
	 * 	await new Promise<void>((resolve) => {
	 * 		context.signal.addEventListener("abort", () => resolve(), { once: true });
	 * 	});
	 * 	context.throwIfCancelled();
	 * }
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
	 * @example
	 * // transfer.ts
	 * import { createPool, createWorkerUrl } from "maligator:workers";
	 *
	 * const tasks = createWorkerUrl<typeof import("./transfer-task.ts")>(
	 * 	"./transfer-task.ts",
	 * 	import.meta.url,
	 * );
	 * const pool = createPool(tasks, { size: 1 });
	 *
	 * try {
	 * 	await pool.ready;
	 * 	const bytes = new Uint8Array([1, 2, 3]);
	 * 	const pending = pool.run("reverse", [bytes.buffer], {
	 * 		transfer: [bytes.buffer],
	 * 	});
	 * 	console.log(bytes.byteLength);
	 * 	const result = new Uint8Array(await pending);
	 * 	console.log(Array.from(result).join(","));
	 * } finally {
	 * 	await pool.close();
	 * }
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
	 * // worker.ts
	 * import { createWorkerUrl, Worker } from "maligator:workers";
	 *
	 * const entry = createWorkerUrl("./echo.ts", import.meta.url);
	 * const worker = new Worker<string, string>(entry);
	 *
	 * try {
	 * 	const reply = new Promise<string>((resolve) => {
	 * 		worker.port.onmessage = (event) => resolve(event.data);
	 * 	});
	 * 	worker.port.start();
	 * 	await worker.ready;
	 * 	worker.port.postMessage("workers");
	 * 	console.log(await reply);
	 * } finally {
	 * 	const exit = await worker.terminate();
	 * 	console.log(exit.reason);
	 * }
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
	 * @example
	 * // channel.ts
	 * import { MessageChannel, MessagePort } from "maligator:workers";
	 *
	 * const channel = new MessageChannel();
	 * try {
	 * 	console.log(channel.port1 instanceof MessagePort);
	 * 	const received = new Promise<unknown>((resolve) => {
	 * 		channel.port2.onmessage = (event) => resolve(event.data);
	 * 	});
	 * 	channel.port2.start();
	 * 	channel.port1.postMessage({ answer: 42 });
	 * 	console.log(JSON.stringify(await received));
	 * } finally {
	 * 	channel.port1.close();
	 * 	channel.port2.close();
	 * }
	 */
	export const MessageChannel: { new (options?: MessageChannelOptions): MessageChannel };
	/**
	 * The port prototype for type and identity checks. Ports are created by channels and
	 * workers.
	 *
	 * @example
	 * // port.ts
	 * import { MessageChannel, type MessagePort } from "maligator:workers";
	 *
	 * function installResponder(port: MessagePort): void {
	 * 	port.onmessage = (event) => port.postMessage("reply:" + String(event.data));
	 * 	port.start();
	 * }
	 *
	 * const { port1, port2 } = new MessageChannel();
	 * try {
	 * 	installResponder(port2);
	 * 	const reply = new Promise<unknown>((resolve) => {
	 * 		port1.onmessage = (event) => resolve(event.data);
	 * 	});
	 * 	port1.start();
	 * 	port1.postMessage("hello");
	 * 	console.log(await reply);
	 * } finally {
	 * 	port1.close();
	 * 	port2.close();
	 * }
	 */
	export const MessagePort: { readonly prototype: MessagePort };
	/**
	 * Synchronously dequeue one pending message without running unrelated callbacks.
	 *
	 * @example
	 * // receive.ts
	 * import { MessageChannel, receiveMessageOnPort } from "maligator:workers";
	 *
	 * const channel = new MessageChannel();
	 * try {
	 * 	channel.port1.postMessage("first");
	 * 	channel.port1.postMessage("second");
	 * 	console.log(receiveMessageOnPort(channel.port2)?.message);
	 * 	console.log(receiveMessageOnPort(channel.port2)?.message);
	 * 	console.log(receiveMessageOnPort(channel.port2));
	 * } finally {
	 * 	channel.port1.close();
	 * 	channel.port2.close();
	 * }
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
	 */
	export const parentPort: MessagePort | null;
	/**
	 * The worker-owned clone of startup data.
	 *
	 * @example
	 * // worker-data.ts
	 * import { workerData } from "maligator:workers";
	 *
	 * function readConfig(value: unknown): { label: string } {
	 * 	if (
	 * 		typeof value !== "object" ||
	 * 		value === null ||
	 * 		!("label" in value) ||
	 * 		typeof value.label !== "string"
	 * 	) {
	 * 		throw new TypeError("Expected worker data with a string label");
	 * 	}
	 * 	return { label: value.label };
	 * }
	 *
	 * const config = readConfig(workerData);
	 * console.log(config.label);
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
	 */
	export const workerData: unknown;
}
