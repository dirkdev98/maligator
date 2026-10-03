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
	 */
	export const createWorkerUrl: <Module = unknown>(
		specifier: string,
		base: string,
	) => WorkerUrl<Module>;
	/**
	 * Create a persistent bounded pool. Submission failures throw synchronously; an
	 * admitted task settles asynchronously.
	 */
	export const createPool: <Module>(
		entry: WorkerUrl<Module>,
		options?: PoolOptions,
	) => WorkerPool<Module>;
	/**
	 * Wrap a result for transfer when the worker publishes it.
	 */
	export const transfer: <Value>(
		value: Value,
		transfer: ReadonlyArray<Transferable>,
	) => TransferResult<Value>;
	/**
	 * Start a declared isolated module and expose its ordered port and complete
	 * lifecycle.
	 */
	export const Worker: {
		new <Send = unknown, Receive = unknown>(
			entry: WorkerUrl,
			options?: WorkerOptions,
		): Worker<Send, Receive>;
	};
	/**
	 * Create two transferable endpoints independently of worker startup.
	 */
	export const MessageChannel: { new (options?: MessageChannelOptions): MessageChannel };
	/**
	 * The port prototype for type and identity checks. Ports are created by channels and
	 * workers.
	 */
	export const MessagePort: { readonly prototype: MessagePort };
	/**
	 * Synchronously dequeue one pending message without running unrelated callbacks.
	 */
	export const receiveMessageOnPort: <Receive>(
		port: MessagePort<unknown, Receive>,
	) => { message: Receive } | undefined;
	/**
	 * Report the running host's worker facilities and capacity.
	 */
	export const capabilities: () => {
		readonly threads: boolean;
		readonly sharedMemory: boolean;
		readonly parallelism: number;
		readonly maxWorkers: number;
	};
	/**
	 * The worker's parent endpoint; null in the main isolate.
	 */
	export const parentPort: MessagePort | null;
	/**
	 * The worker-owned clone of startup data.
	 */
	export const workerData: unknown;
}
