// Generated from src/platform/catalog.ts; edit the catalog and regenerate.
/**
 * Toolchain-owned worker substrate used by the public source API and Node
 * compatibility personality.
 */
declare module "maligator:internal/workers" {
	import type * as Workers from "maligator:workers";
	/**
	 * Values whose ownership moves when a message is admitted.
	 */
	export type Transferable = Workers.Transferable;

	/**
	 * A terminal record. The error is the uncaught value as thrown.
	 */
	export type WorkerExit = {
		readonly id: number;
		readonly code: number;
		readonly reason: "completed" | "terminated" | "error";
		readonly error?: unknown;
	};

	/**
	 * A worker's uncaught value as thrown and its own string message, or the empty
	 * string.
	 */
	export type WorkerErrorEvent = Event & {
		readonly error: unknown;
		readonly message: string;
	};

	/**
	 * A transactional endpoint. postMessage returns the admission ticket, or undefined
	 * when nothing was queued; _discard drops a posted message the peer has not
	 * received.
	 */
	export type MessagePort<Send = unknown, Receive = unknown> = {
		postMessage(value: Send, transfer?: ReadonlyArray<Transferable>): number | undefined;
		_discard(ticket: number): boolean;
		addEventListener(
			type: "message",
			listener: (event: MessageEvent<Receive>) => void | Promise<void>,
			options?: AddEventListenerOptions | boolean,
		): void;
		onmessage: ((event: MessageEvent<Receive>) => void) | null;
		onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
		start(): void;
		close(): void;
		ref(): MessagePort<Send, Receive>;
		unref(): MessagePort<Send, Receive>;
		hasRef(): boolean;
	} & EventTarget;

	/**
	 * A channel whose first port sends Forward messages and receives Backward messages.
	 */
	export type MessageChannel<Forward = unknown, Backward = unknown> = {
		readonly port1: MessagePort<Forward, Backward>;
		readonly port2: MessagePort<Backward, Forward>;
	};

	/**
	 * A source-API worker handle over a transactional parent port.
	 */
	export type Worker<Send = unknown, Receive = unknown> = {
		readonly id: number;
		readonly ready: Promise<void>;
		readonly closed: Promise<WorkerExit>;
		readonly port: MessagePort<Send, Receive>;
		addEventListener(
			type: "error",
			listener: (event: WorkerErrorEvent) => void,
			options?: AddEventListenerOptions | boolean,
		): void;
		terminate(): Promise<WorkerExit>;
		ref(): Worker<Send, Receive>;
		unref(): Worker<Send, Receive>;
		hasRef(): boolean;
	} & EventTarget;

	/**
	 * Start a declared isolated module with a transactional parent port.
	 */
	export const Worker: {
		new <Send = unknown, Receive = unknown>(
			entry: { readonly href: string },
			options?: Workers.WorkerOptions,
		): Worker<Send, Receive>;
	};
	/**
	 * Create two transactional endpoints.
	 */
	export const MessageChannel: {
		new <Forward = unknown, Backward = unknown>(
			options?: Workers.MessageChannelOptions,
		): MessageChannel<Forward, Backward>;
	};
	/**
	 * The transactional port prototype.
	 */
	export const MessagePort: { readonly prototype: MessagePort };
	/**
	 * Synchronously dequeue one pending message without running unrelated callbacks.
	 */
	export const receiveMessageOnPort: <Receive>(
		port: MessagePort<unknown, Receive>,
	) => { readonly message: Receive } | undefined;
	/**
	 * Report the running host's worker facilities and capacity.
	 */
	export const capabilities: typeof Workers.capabilities;
	/**
	 * Fail the current worker after its outcome cannot be published.
	 */
	export const failCurrent: () => void;
	/**
	 * Internal static entry declaration.
	 */
	export const createWorkerUrl: (
		specifier: string,
		base: string,
	) => { readonly href: string };
	/**
	 * Isolate-owned worker state.
	 */
	export const parentPort: MessagePort | null;
	/**
	 * Isolate-owned worker state.
	 */
	export const workerData: unknown;
	/**
	 * The task-pool bootstrap entry.
	 */
	export const poolEntry: { readonly href: string };
}
