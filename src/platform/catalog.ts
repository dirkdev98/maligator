import {
	NO_EFFECT_SUMMARY,
	EVERY_EFFECT_SUMMARY,
} from "../compiler/shared/effect-summary.ts";
import type { EffectSummary } from "../compiler/shared/effect-summary.ts";

export type PlatformData =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<PlatformData>
	| { readonly [key: string]: PlatformData };

export type PlatformType =
	| { readonly kind: "signature"; readonly source: string }
	| { readonly kind: "primitive"; readonly name: "string" | "number" | "boolean" }
	| { readonly kind: "literal"; readonly value: string | boolean | null }
	| { readonly kind: "reference"; readonly name: string }
	| { readonly kind: "array"; readonly element: PlatformType }
	| { readonly kind: "record"; readonly value: PlatformType }
	| { readonly kind: "object"; readonly properties: ReadonlyArray<PlatformProperty> }
	| {
			readonly kind: "union" | "intersection";
			readonly types: ReadonlyArray<PlatformType>;
	  };

export interface PlatformDocumentation {
	readonly description: string;
	readonly examples?: ReadonlyArray<string>;
}

export interface PlatformProperty extends PlatformDocumentation {
	readonly name: string;
	readonly type: PlatformType;
}

export type PlatformTypeDefinition = PlatformProperty &
	(
		| { readonly declaration?: "type" }
		| {
				readonly declaration: "interface";
				readonly extends?: ReadonlyArray<string>;
		  }
	);

export interface PlatformExport extends PlatformDocumentation {
	readonly name: string;
	readonly type: PlatformType;
	readonly contract: {
		readonly phase: "preparation" | "runtime";
		readonly value: "deep-frozen-data" | "callable" | "runtime-data";
		readonly identity: "application-context" | "module";
		readonly provider?: "execution";
		readonly declaration?: "worker-entry";
		readonly workerSource?: string;
		readonly effects: EffectSummary;
	};
}

interface PlatformModuleDefinition extends PlatformDocumentation {
	readonly id: `maligator:${string}`;
	readonly stability: "experimental";
	readonly evaluation: "side-effect-free";
	readonly declarationFile: string;
	readonly internal?: true;
	readonly typeImports?: ReadonlyArray<{
		readonly namespace: string;
		readonly from: string;
	}>;
	readonly types: ReadonlyArray<PlatformTypeDefinition>;
	readonly exports: ReadonlyArray<PlatformExport>;
}

export type PlatformModule = PlatformModuleDefinition &
	(
		| { readonly kind: "native"; readonly installer: string }
		| { readonly kind: "source"; readonly sourceFile: string }
	);

const string: PlatformType = { kind: "primitive", name: "string" };
const number: PlatformType = { kind: "primitive", name: "number" };
const boolean: PlatformType = { kind: "primitive", name: "boolean" };
const reference = (name: string): PlatformType => ({ kind: "reference", name });
const literal = (value: string | boolean | null): PlatformType => ({
	kind: "literal",
	value,
});
const union = (...types: Array<PlatformType>): PlatformType => ({ kind: "union", types });
const array = (element: PlatformType): PlatformType => ({ kind: "array", element });
const object = (properties: Array<PlatformProperty>): PlatformType => ({
	kind: "object",
	properties,
});
const property = (
	name: string,
	type: PlatformType,
	description: string,
): PlatformProperty => ({ name, type, description });

const executionTypes: ReadonlyArray<PlatformTypeDefinition> = [
	property(
		"ExecutionProfile",
		union(literal("none"), literal("sampling"), literal("compiler")),
		"Profiling instrumentation: none by default; sampling for --profile; compiler for --profile=compiler. Both profiling modes select full optimization without selecting production application behavior.",
	),
	property(
		"ExecutionTarget",
		object([
			property(
				"platform",
				union(literal("darwin"), literal("linux"), literal("wasi")),
				"Application operating-system target, not the compiler host. Native builds use darwin or linux; WebAssembly uses wasi.",
			),
			property(
				"arch",
				union(literal("arm64"), literal("x64"), literal("wasm32")),
				"Application architecture. Cross builds report the destination architecture.",
			),
			property(
				"triple",
				string,
				"Resolved target triple, including when --target was omitted; for example aarch64-apple-darwin.",
			),
		]),
		"The fixed platform contract of the application image.",
	),
	property(
		"ExecutionOptions",
		object([
			property(
				"profile",
				reference("ExecutionProfile"),
				"Selected application profiling instrumentation. Defaults to none; does not imply execution.production.",
			),
		]),
		"Options shared by build, run, and dev. Output paths, verbosity, and compiler scheduling are tool settings and are not exposed.",
	),
	property(
		"TestExecutionOptions",
		object([
			property(
				"profile",
				reference("ExecutionProfile"),
				"Selected test profiling instrumentation. Defaults to none; profiling preserves command: test.",
			),
			property(
				"nameFilter",
				union(string, literal(null)),
				"Hierarchical test-name filter from --run, or null when all discovered names are eligible.",
			),
			property(
				"repeat",
				number,
				"Number of requested test repetitions from --repeat; defaults to 1. This is not the currently executing repetition.",
			),
			property(
				"bail",
				boolean,
				"Whether --bail stops the test run after its first failure. Defaults to false.",
			),
			property(
				"timeoutMs",
				number,
				"Test callback timeout in milliseconds from --timeout. Defaults to 5000.",
			),
			property(
				"shuffleSeed",
				union(number, literal(null)),
				"Resolved positive shuffle seed, or null when shuffling is disabled. --shuffle without a seed chooses it once before compilation; the same seed drives execution and cache identity.",
			),
		]),
		"Normalized test settings, fixed for the application image. Changing these values invalidates specialized test artifacts.",
	),
	property(
		"ExecutionEngineConfig",
		object([
			property(
				"primordials",
				union(literal("locked"), literal("mutable")),
				"Requested primordial mutation policy. Defaults to locked. The execution snapshot itself is immutable in either policy.",
			),
			property(
				"eval",
				union(boolean, literal("compile-check")),
				"Dynamic compilation policy. false (default) rejects eval/Function execution at runtime; true enables the runtime compiler; compile-check additionally rejects statically visible dynamic compilation calls.",
			),
			property(
				"realms",
				boolean,
				"Whether additional realms are enabled. Defaults to false.",
			),
			property(
				"regexp",
				boolean,
				"Whether regular expressions are enabled. Defaults to true.",
			),
			property(
				"temporal",
				boolean,
				"Whether Temporal and its required data are enabled. Defaults to false.",
			),
			property(
				"intl",
				object([
					property("enabled", boolean, "Whether Intl is enabled. Defaults to false."),
					property(
						"features",
						array(string),
						"Requested Intl service names. An empty array selects the default complete service set when Intl is enabled; it does not mean every service survived tree shaking.",
					),
					property(
						"languages",
						array(string),
						"Requested locale selection. Defaults to an empty array. Unsupported locale selections are rejected by configuration validation.",
					),
				]),
				"Requested Intl policy after applying configuration defaults.",
			),
		]),
		"Resolved engine policies. These describe build inputs, never post-DCE native feature inclusion.",
	),
	property(
		"ExecutionConfig",
		object([
			property(
				"engine",
				reference("ExecutionEngineConfig"),
				"Engine configuration after validation and default resolution.",
			),
			property(
				"surface",
				object([
					property(
						"webPlatform",
						boolean,
						"Whether Web globals are requested. Defaults to false; native module imports are independent of this global installation policy.",
					),
					property(
						"node",
						boolean,
						"Whether Node compatibility, globals, and node: module resolution are requested. Defaults to false.",
					),
				]),
				"Global and compatibility surface policy. maligator:process requires no enable flag.",
			),
			property(
				"modules",
				object([
					property(
						"aliases",
						{ kind: "record", value: string },
						"Exact module-specifier replacements from configuration. Defaults to an empty object. Alias entries are immutable own data properties.",
					),
				]),
				"Resolved module-resolution policy.",
			),
		]),
		"Resolved application engine, Web/Node surface, and module policies. Excludes build-host paths, asset declarations, and output controls.",
	),
	property(
		"ExecutionCommon",
		object([
			property(
				"production",
				boolean,
				"Explicit production application intent. True only when production was selected for the application; independent of NODE_ENV, profiling, and optimization. Currently --production is a build option. Defaults to false.",
			),
			property(
				"compiled",
				boolean,
				"Whether the application image executes as native compiled code. A native executable hosting an interpreted image reports false. This is fixed for the image, not a query about the current stack frame or an eval-created function.",
			),
			property(
				"optimization",
				union(literal("development"), literal("full")),
				"Actual selected frontend optimization policy. Ordinary commands currently use development; production builds and profiling use full. Backend choice is independent.",
			),
			property(
				"target",
				reference("ExecutionTarget"),
				"Resolved application target. The compiler's host platform is not substituted during a cross build.",
			),
			property(
				"config",
				reference("ExecutionConfig"),
				"Validated configuration policies with defaults applied, captured before compilation.",
			),
		]),
		"Fields shared by every execution workflow. All nested objects and arrays are deeply frozen at runtime.",
	),
	property(
		"Execution",
		{
			kind: "intersection",
			types: [
				reference("ExecutionCommon"),
				union(
					object([
						property(
							"command",
							literal("build"),
							"Prepared by maligator build. Remains build when the resulting executable runs later; application statements are not executed by the build itself.",
						),
						property(
							"options",
							reference("ExecutionOptions"),
							"Normalized build options relevant to application execution.",
						),
					]),
					object([
						property(
							"command",
							union(literal("run"), literal("dev")),
							"Prepared by maligator run or maligator dev. dev denotes the watch/restart workflow even when profiling selects native compilation.",
						),
						property(
							"options",
							reference("ExecutionOptions"),
							"Normalized run/dev options. Arguments after -- remain runtime argv and do not specialize application compilation.",
						),
					]),
					object([
						property(
							"command",
							literal("test"),
							"Prepared by maligator test. Preserved for interpreted tests, profiled native tests, and every fragment of the test application.",
						),
						property(
							"options",
							reference("TestExecutionOptions"),
							"Normalized test options. Narrow command to test before accessing test-only fields.",
						),
					]),
				),
			],
		},
		"An immutable application-image description, discriminated by command. The command describes the workflow that prepared the image, not a transient process phase.",
	),
];

const workerType = (
	name: string,
	source: string,
	description: string,
): PlatformTypeDefinition => property(name, { kind: "signature", source }, description);

const workerTypes: ReadonlyArray<PlatformTypeDefinition> = [
	workerType(
		"WorkerUrl<Module = unknown>",
		"{ readonly href: string; readonly __workerModule?: Module }",
		"An immutable image-local worker entry declaration. The compiler resolves the declaration independently of how libraries pass the descriptor or its href onward. Erased module types express the caller's assertion; runtime entry identity is validated.",
	),
	workerType(
		"Transferable",
		"ArrayBuffer | MessagePort",
		"ArrayBuffer stores move at admission. MessagePort endpoints transfer ownership. SharedArrayBuffer is cloned by sharing its backing and cannot be transferred.",
	),
	workerType(
		"TaskContext",
		"{\n /** Worker-local cancellation signal. Cancellation does not preempt JavaScript. */\n readonly signal: AbortSignal;\n /** Throws if cancelled. Check between bounded pieces of work. */\n throwIfCancelled(): void;\n}",
		"Cancellation is cooperative while a pool task runs. The worker remains occupied until the task's returned promise settles.",
	),
	workerType(
		"TransferResult<Value>",
		"{ readonly value: Value; readonly __transferResult: unique symbol }",
		"An opaque result envelope. Constructing it does not detach buffers; publication commits transfers.",
	),
	workerType(
		"TaskNames<Module>",
		"{ [Key in keyof Module]-?: Module[Key] extends (context: TaskContext, ...args: infer Args) => unknown ? Key : never }[keyof Module] & string",
		"Names of context-first exported task functions.",
	),
	workerType(
		"TaskArgs<Function>",
		"Function extends (context: TaskContext, ...args: infer Args) => unknown ? Args : never",
		"The task's argument tuple, excluding its local cancellation context.",
	),
	workerType(
		"TaskValue<Function>",
		"Function extends (...args: Array<never>) => infer Result ? Awaited<Result> extends TransferResult<infer Value> ? Value : Awaited<Result> : never",
		"The settled task result after unwrapping an explicit transfer envelope.",
	),
	workerType(
		"PoolOptions",
		"{\n /** Positive safe integer; defaults to host parallelism, falling back to 1. */\n size?: number;\n /** Nonnegative safe integer; defaults to four times size. Zero disables the waiting queue. */\n maxQueuedTasks?: number;\n /** Positive safe integer in bytes; defaults to 67108864 (64 MiB). */\n maxQueuedBytes?: number;\n /** Positive safe integer in bytes; defaults to maxQueuedBytes. */\n maxMessageBytes?: number;\n /** Worker name prefix; each worker receives a one-based suffix. */\n name?: string;\n}",
		"Fixed persistent worker count and admission bounds. Every worker has independent module state. A size-one pool dispatches admitted tasks serially.",
	),
	workerType(
		"RunOptions",
		"{\n /** Already-aborted signals throw before admission. Running cancellation is cooperative. */\n signal?: AbortSignal;\n /** Ownership moves synchronously on successful admission; rejection leaves values unchanged. */\n transfer?: ReadonlyArray<Transferable>;\n}",
		"The transfer list commits synchronously when run returns normally. Validation, saturation, closed pools and already-aborted signals throw before admission.",
	),
	workerType(
		"MapOptions<Args>",
		"{\n /** Cancels only work owned by this map; running tasks must cooperate. */\n signal?: AbortSignal;\n /** Positive safe integer; defaults to pool size. Bounds pulled inputs and buffered results together. */\n window?: number;\n /** Called for each input before admission to choose values whose ownership moves. */\n transfer?: (args: Args, index: number) => ReadonlyArray<Transferable>;\n}",
		"The window bounds pulled inputs and buffered results together. Results are yielded in input order; iterator return cancels this map's work and closes its input.",
	),
	workerType(
		"PoolStats",
		"{ readonly size: number; readonly active: number; readonly queued: number; readonly completed: number; readonly failed: number; readonly cancelled: number }",
		"A snapshot of this pool's scheduling and settled operations.",
	),
	workerType(
		"WorkerPool<Module>",
		"{\n /** Resolves after every worker evaluates the entry; rejects on startup failure. */\n readonly ready: Promise<void>;\n /** Throws on failed admission; returns a promise for the accepted task's result or failure. */\n run<Key extends TaskNames<Module>>(name: Key, args: TaskArgs<Module[Key]>, options?: RunOptions): Promise<TaskValue<Module[Key]>>;\n /** Yields in input order. Returning from the iterator cancels its work and closes its input. */\n map<Key extends TaskNames<Module>>(name: Key, args: Iterable<TaskArgs<Module[Key]>> | AsyncIterable<TaskArgs<Module[Key]>>, options?: MapOptions<TaskArgs<Module[Key]>>): AsyncIterable<TaskValue<Module[Key]>>;\n /** Stops admission, drains accepted tasks, then joins every worker. Idempotent. */\n close(): Promise<void>;\n /** Rejects outstanding tasks with AbortError; joins workers after running tasks cooperate and settle. */\n terminate(): Promise<void>;\n /** Returns a scheduling snapshot; counts are not a subscription. */\n stats(): PoolStats;\n /** Keeps the process alive while pool workers exist; returns this pool. */\n ref(): WorkerPool<Module>;\n /** Allows the process to exit without waiting for this pool; returns this pool. */\n unref(): WorkerPool<Module>;\n /** Reports whether this pool currently keeps the process alive. */\n hasRef(): boolean;\n}",
		"A bounded task scheduler over isolated persistent workers. Each worker executes one task through asynchronous settlement. No accepted task is replayed after worker failure.",
	),
	workerType(
		"WorkerExit",
		"{ readonly id: number; readonly code: number; readonly reason: 'completed' | 'terminated' | 'error'; readonly error?: unknown }",
		"A terminal record published only after the native worker is joined and its slot is released.",
	),
	workerType(
		"WorkerOptions",
		"{\n name?: string;\n /** Cloned into workerData before startup; later caller mutations are not shared. */\n data?: unknown;\n /** Values moved as part of startup-data admission. */\n transfer?: ReadonlyArray<Transferable>;\n /** Positive safe integer, at most 4294967295; defaults to 4096 messages per endpoint. */\n maxQueuedMessages?: number;\n /** Positive safe integer in bytes; defaults to 67108864 (64 MiB) per endpoint. */\n maxQueuedBytes?: number;\n /** Positive safe integer in bytes; defaults to 16777216 (16 MiB) per message. */\n maxMessageBytes?: number;\n}",
		"Worker data is snapshotted before startup. The native host bounds live workers and message admission process-wide.",
	),
	workerType(
		"MessageChannelOptions",
		"{\n /** Positive safe integer, at most 4294967295; defaults to 4096 messages per endpoint. */\n maxQueuedMessages?: number;\n /** Positive safe integer in bytes; defaults to 67108864 (64 MiB) per endpoint. */\n maxQueuedBytes?: number;\n /** Positive safe integer in bytes; defaults to 16777216 (16 MiB) per message. */\n maxMessageBytes?: number;\n}",
		"Each endpoint bounds its pending message count and bytes. Rejection leaves the sender's transferables unchanged.",
	),
	{
		...workerType(
			"MessagePort<Send = unknown, Receive = unknown>",
			"{\n /** Clones and admits a message synchronously. Transfer commits only after successful validation/admission. */\n postMessage(value: Send, transfer?: ReadonlyArray<Transferable>): void;\n /** Setting this handler starts delivery. addEventListener listeners need start(). */\n onmessage: ((event: MessageEvent<Receive>) => void) | null;\n /** Receives message decoding failures in the receiving isolate. */\n onmessageerror: ((event: MessageEvent<unknown>) => void) | null;\n /** Enables delivery to event listeners; repeated calls are harmless. */\n start(): void;\n /** Discards queued messages and closes this endpoint. */\n close(): void;\n /** Keeps the receiving isolate alive; returns this port. */\n ref(): MessagePort<Send, Receive>;\n /** Allows the receiving isolate to exit; returns this port. */\n unref(): MessagePort<Send, Receive>;\n hasRef(): boolean;\n}",
			"An ordered bidirectional endpoint with transactional transfer and bounded queues. Message listeners and values are owned by the receiving isolate.",
		),
		// An interface permits Transferable's recursion through this generic port contract.
		declaration: "interface",
		extends: ["EventTarget"],
	},
	workerType(
		"MessageChannel",
		"{ readonly port1: MessagePort; readonly port2: MessagePort }",
		"A standalone channel whose endpoints may be transferred to workers.",
	),
	workerType(
		"Worker<Send = unknown, Receive = unknown>",
		"EventTarget & {\n readonly id: number;\n /** Resolves after entry evaluation; rejects on startup failure. */\n readonly ready: Promise<void>;\n /** Resolves with a terminal record after the native thread is joined and its slot released. */\n readonly closed: Promise<WorkerExit>;\n readonly port: MessagePort<Send, Receive>;\n /** Requests shutdown and resolves after thread reaping. */\n terminate(): Promise<WorkerExit>;\n ref(): Worker<Send, Receive>;\n unref(): Worker<Send, Receive>;\n hasRef(): boolean;\n}",
		"A long-lived isolated module and its parent communication port. Startup completes after module evaluation; shutdown completes after native thread reaping.",
	),
];

const internalWorkerTypes: ReadonlyArray<PlatformTypeDefinition> = [
	workerType(
		"Transferable",
		"Workers.Transferable",
		"Values whose ownership moves when a message is admitted.",
	),
	workerType(
		"WorkerExit",
		"{ readonly id: number; readonly code: number; readonly reason: 'completed' | 'terminated' | 'error'; readonly error?: unknown }",
		"A terminal record. The error is the uncaught value as thrown.",
	),
	workerType(
		"WorkerErrorEvent",
		"Event & { readonly error: unknown; readonly message: string }",
		"A worker's uncaught value as thrown and its own string message, or the empty string.",
	),
	workerType(
		"MessagePort<Send = unknown, Receive = unknown>",
		"{ postMessage(value: Send, transfer?: ReadonlyArray<Transferable>): number | undefined; _discard(ticket: number): boolean; addEventListener(type: 'message', listener: (event: MessageEvent<Receive>) => void | Promise<void>, options?: AddEventListenerOptions | boolean): void; onmessage: ((event: MessageEvent<Receive>) => void) | null; onmessageerror: ((event: MessageEvent<unknown>) => void) | null; start(): void; close(): void; ref(): MessagePort<Send, Receive>; unref(): MessagePort<Send, Receive>; hasRef(): boolean } & EventTarget",
		"A transactional endpoint. postMessage returns the admission ticket, or undefined when nothing was queued; _discard drops a posted message the peer has not received.",
	),
	workerType(
		"MessageChannel<Forward = unknown, Backward = unknown>",
		"{ readonly port1: MessagePort<Forward, Backward>; readonly port2: MessagePort<Backward, Forward> }",
		"A channel whose first port sends Forward messages and receives Backward messages.",
	),
	workerType(
		"Worker<Send = unknown, Receive = unknown>",
		"{ readonly id: number; readonly ready: Promise<void>; readonly closed: Promise<WorkerExit>; readonly port: MessagePort<Send, Receive>; addEventListener(type: 'error', listener: (event: WorkerErrorEvent) => void, options?: AddEventListenerOptions | boolean): void; terminate(): Promise<WorkerExit>; ref(): Worker<Send, Receive>; unref(): Worker<Send, Receive>; hasRef(): boolean } & EventTarget",
		"A source-API worker handle over a transactional parent port.",
	),
];

export const workerExamples = {
	sum: `// sum.ts
import type { TaskContext } from "maligator:workers";

export function sum(context: TaskContext, values: Array<number>): number {
	context.throwIfCancelled();
	return values.reduce((total, value) => total + value, 0);
}`,
	tasks: `// tasks.ts
import type { TaskContext } from "maligator:workers";

export function sum(context: TaskContext, values: Array<number>): number {
	let total = 0;
	for (const value of values) {
		context.throwIfCancelled();
		total += value;
	}
	return total;
}

export async function waitForCancellation(context: TaskContext): Promise<void> {
	context.throwIfCancelled();
	await new Promise<void>((resolve) => {
		context.signal.addEventListener("abort", () => resolve(), { once: true });
	});
	context.throwIfCancelled();
}`,
	declaration: `// declaration.ts
import { createWorkerUrl } from "maligator:workers";

export const tasks = createWorkerUrl<typeof import("./sum.ts")>(
	"./sum.ts",
	import.meta.url,
);

console.log(Object.isFrozen(tasks), tasks.href.startsWith("file:"));`,
	pool: `// pool.ts
import { createPool, createWorkerUrl } from "maligator:workers";

const tasks = createWorkerUrl<typeof import("./tasks.ts")>(
	"./tasks.ts",
	import.meta.url,
);
const pool = createPool(tasks, { size: 2, maxQueuedTasks: 4 });

try {
	await pool.ready;
	console.log(await pool.run("sum", [[1, 2, 3]]));

	const inputs: Array<[Array<number>]> = [[[1, 2]], [[3, 4]]];
	for await (const total of pool.map("sum", inputs, { window: 2 })) {
		console.log(total);
	}

	const controller = new AbortController();
	const pending = pool.run("waitForCancellation", [], {
		signal: controller.signal,
	});
	const cancelled = pending.then(
		() => false,
		(reason: unknown) => reason === controller.signal.reason,
	);
	controller.abort();
	console.log(await cancelled);
} finally {
	await pool.close();
}`,
	transferTask: `// transfer-task.ts
import { transfer } from "maligator:workers";
import type { TaskContext } from "maligator:workers";

export function reverse(context: TaskContext, buffer: ArrayBuffer) {
	context.throwIfCancelled();
	new Uint8Array(buffer).reverse();
	return transfer(buffer, [buffer]);
}`,
	transfer: `// transfer.ts
import { createPool, createWorkerUrl } from "maligator:workers";

const tasks = createWorkerUrl<typeof import("./transfer-task.ts")>(
	"./transfer-task.ts",
	import.meta.url,
);
const pool = createPool(tasks, { size: 1 });

try {
	await pool.ready;
	const bytes = new Uint8Array([1, 2, 3]);
	const pending = pool.run("reverse", [bytes.buffer], {
		transfer: [bytes.buffer],
	});
	console.log(bytes.byteLength);
	const result = new Uint8Array(await pending);
	console.log(Array.from(result).join(","));
} finally {
	await pool.close();
}`,
	echo: `// echo.ts
import { parentPort } from "maligator:workers";

if (parentPort === null) throw new Error("Run this module as a worker");
const port = parentPort;
port.onmessage = (event) => {
	port.postMessage(String(event.data));
};
port.start();`,
	worker: `// worker.ts
import { createWorkerUrl, Worker } from "maligator:workers";

const entry = createWorkerUrl("./echo.ts", import.meta.url);
const worker = new Worker<string, string>(entry);

try {
	const reply = new Promise<string>((resolve) => {
		worker.port.onmessage = (event) => resolve(event.data);
	});
	worker.port.start();
	await worker.ready;
	worker.port.postMessage("workers");
	console.log(await reply);
} finally {
	const exit = await worker.terminate();
	console.log(exit.reason);
}`,
	workerData: `// worker-data.ts
import { workerData } from "maligator:workers";

function readConfig(value: unknown): { label: string } {
	if (
		typeof value !== "object" ||
		value === null ||
		!("label" in value) ||
		typeof value.label !== "string"
	) {
		throw new TypeError("Expected worker data with a string label");
	}
	return { label: value.label };
}

const config = readConfig(workerData);
console.log(config.label);`,
	configuration: `// configuration.ts
import { createWorkerUrl, Worker } from "maligator:workers";

const entry = createWorkerUrl("./worker-data.ts", import.meta.url);
const worker = new Worker(entry, { data: { label: "thumbnail" } });
try {
	await worker.ready;
	const exit = await worker.closed;
	if (exit.code !== 0) throw new Error("Worker failed");
} finally {
	await worker.terminate();
}`,
	channel: `// channel.ts
import { MessageChannel, MessagePort } from "maligator:workers";

const channel = new MessageChannel();
try {
	console.log(channel.port1 instanceof MessagePort);
	const received = new Promise<unknown>((resolve) => {
		channel.port2.onmessage = (event) => resolve(event.data);
	});
	channel.port2.start();
	channel.port1.postMessage({ answer: 42 });
	console.log(JSON.stringify(await received));
} finally {
	channel.port1.close();
	channel.port2.close();
}`,
	port: `// port.ts
import { MessageChannel, type MessagePort } from "maligator:workers";

function installResponder(port: MessagePort): void {
	port.onmessage = (event) => port.postMessage("reply:" + String(event.data));
	port.start();
}

const { port1, port2 } = new MessageChannel();
try {
	installResponder(port2);
	const reply = new Promise<unknown>((resolve) => {
		port1.onmessage = (event) => resolve(event.data);
	});
	port1.start();
	port1.postMessage("hello");
	console.log(await reply);
} finally {
	port1.close();
	port2.close();
}`,
	receive: `// receive.ts
import { MessageChannel, receiveMessageOnPort } from "maligator:workers";

const channel = new MessageChannel();
try {
	channel.port1.postMessage("first");
	channel.port1.postMessage("second");
	console.log(receiveMessageOnPort(channel.port2)?.message);
	console.log(receiveMessageOnPort(channel.port2)?.message);
	console.log(receiveMessageOnPort(channel.port2));
} finally {
	channel.port1.close();
	channel.port2.close();
}`,
	capabilities: `// capabilities.ts
import { capabilities } from "maligator:workers";

const host = capabilities();
console.log(host.threads, host.sharedMemory);
console.log(host.parallelism >= 1, host.maxWorkers >= 1);`,
} as const;

function workerExport(
	name: string,
	source: string,
	description: string,
	declaration = false,
	examples?: ReadonlyArray<string>,
): PlatformExport {
	return {
		name,
		type: { kind: "signature", source },
		description,
		...(examples === undefined ? {} : { examples }),
		contract: {
			phase: "runtime",
			value: "callable",
			identity: "module",
			effects: EVERY_EFFECT_SUMMARY,
			...(declaration ? { declaration: "worker-entry" as const } : {}),
		},
	};
}

export const PLATFORM_CATALOG_VERSION = 2;

export const PLATFORM_MODULES: ReadonlyArray<PlatformModule> = [
	{
		kind: "native",
		id: "maligator:application",
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_application",
		declarationFile: "application-api.d.ts",
		description:
			"Runtime lifecycle notifications for supervised applications. Module evaluation and application readiness are separate events; readiness means the application has finished its own startup work.",
		types: [],
		exports: [
			{
				name: "ready",
				type: { kind: "signature", source: "() => boolean" },
				description:
					"Notify the development supervisor that this application is ready. Repeated calls are harmless. Returns true in a supervised application and false in a standalone application or ordinary worker. Call after resources such as a server listener are accepting work; this does not reserve ports or transfer traffic.",
				examples: [
					'import { ready } from "maligator:application";\nimport { createServer } from "node:http";\n\ncreateServer((_request, response) => response.end("hello")).listen(3000, () => ready());',
				],
				contract: {
					phase: "runtime",
					value: "callable",
					identity: "module",
					effects: EVERY_EFFECT_SUMMARY,
				},
			},
		],
	},
	{
		kind: "source",
		id: "maligator:workers",
		stability: "experimental",
		evaluation: "side-effect-free",
		sourceFile: "workers/runtime.ts",
		declarationFile: "workers-api.d.ts",
		description:
			"Parallel computation and isolated event loops. Declared entries are bundled into the application image; workers do not compile or load source files at runtime. Native executors and GC helpers are shared across JavaScript isolates.",
		types: workerTypes,
		exports: [
			workerExport(
				"createWorkerUrl",
				"<Module = unknown>(specifier: string, base: string) => WorkerUrl<Module>",
				"Declare an entry using a static string literal and explicit import.meta.url base. The immutable href projection can be passed to existing worker libraries.",
				true,
				[workerExamples.declaration, workerExamples.sum],
			),
			workerExport(
				"createPool",
				"<Module>(entry: WorkerUrl<Module>, options?: PoolOptions) => WorkerPool<Module>",
				"Create a bounded pool of persistent workers for a declared entry. Submission failures throw synchronously; admitted tasks settle asynchronously. Await ready before submitting startup-dependent work and close the pool when finished. Throws NotSupportedError without threads and RangeError for invalid bounds.",
				false,
				[workerExamples.pool, workerExamples.tasks],
			),
			workerExport(
				"transfer",
				"<Value>(value: Value, transfer: ReadonlyArray<Transferable>) => TransferResult<Value>",
				"Wrap a result for transfer when the worker publishes it.",
				false,
				[workerExamples.transferTask, workerExamples.transfer],
			),
			workerExport(
				"Worker",
				"{ new<Send = unknown, Receive = unknown>(entry: WorkerUrl, options?: WorkerOptions): Worker<Send, Receive> }",
				"Start a declared isolated module and expose its ordered port and complete lifecycle.",
				false,
				[workerExamples.worker, workerExamples.echo],
			),
			workerExport(
				"MessageChannel",
				"{ new(options?: MessageChannelOptions): MessageChannel }",
				"Create two transferable endpoints independently of worker startup.",
				false,
				[workerExamples.channel],
			),
			workerExport(
				"MessagePort",
				"{ readonly prototype: MessagePort }",
				"The port prototype for type and identity checks. Ports are created by channels and workers.",
				false,
				[workerExamples.port],
			),
			workerExport(
				"receiveMessageOnPort",
				"<Receive>(port: MessagePort<unknown, Receive>) => { message: Receive } | undefined",
				"Synchronously dequeue one pending message without running unrelated callbacks.",
				false,
				[workerExamples.receive],
			),
			workerExport(
				"capabilities",
				"() => { readonly threads: boolean; readonly sharedMemory: boolean; readonly parallelism: number; readonly maxWorkers: number }",
				"Report the running host's worker facilities and capacity.",
				false,
				[workerExamples.capabilities],
			),
			{
				name: "parentPort",
				type: { kind: "signature", source: "MessagePort | null" },
				description: "The worker's parent endpoint; null in the main isolate.",
				examples: [workerExamples.echo],
				contract: {
					phase: "runtime",
					value: "runtime-data",
					identity: "module",
					effects: NO_EFFECT_SUMMARY,
				},
			},
			{
				name: "workerData",
				type: { kind: "signature", source: "unknown" },
				description: "The worker-owned clone of startup data.",
				examples: [workerExamples.workerData, workerExamples.configuration],
				contract: {
					phase: "runtime",
					value: "runtime-data",
					identity: "module",
					effects: NO_EFFECT_SUMMARY,
				},
			},
		],
	},
	{
		kind: "native",
		id: "maligator:internal/workers",
		internal: true,
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_internal_workers",
		declarationFile: "workers-host-api.d.ts",
		typeImports: [{ namespace: "Workers", from: "maligator:workers" }],
		description:
			"Toolchain-owned worker substrate used by the public source API and Node compatibility personality.",
		types: internalWorkerTypes,
		exports: [
			workerExport(
				"Worker",
				"{ new <Send = unknown, Receive = unknown>(entry: { readonly href: string }, options?: Workers.WorkerOptions): Worker<Send, Receive> }",
				"Start a declared isolated module with a transactional parent port.",
			),
			workerExport(
				"MessageChannel",
				"{ new <Forward = unknown, Backward = unknown>(options?: Workers.MessageChannelOptions): MessageChannel<Forward, Backward> }",
				"Create two transactional endpoints.",
			),
			workerExport(
				"MessagePort",
				"{ readonly prototype: MessagePort }",
				"The transactional port prototype.",
			),
			workerExport(
				"receiveMessageOnPort",
				"<Receive>(port: MessagePort<unknown, Receive>) => { readonly message: Receive } | undefined",
				"Synchronously dequeue one pending message without running unrelated callbacks.",
			),
			workerExport(
				"capabilities",
				"typeof Workers.capabilities",
				"Report the running host's worker facilities and capacity.",
			),
			workerExport(
				"failCurrent",
				"() => void",
				"Fail the current worker after its outcome cannot be published.",
			),
			workerExport(
				"createWorkerUrl",
				"(specifier: string, base: string) => { readonly href: string }",
				"Internal static entry declaration.",
				true,
			),
			...[
				{ name: "parentPort", source: "MessagePort | null" },
				{ name: "workerData", source: "unknown" },
			].map(({ name, source }): PlatformExport => ({
				name,
				type: { kind: "signature", source },
				description: "Isolate-owned worker state.",
				contract: {
					phase: "runtime",
					value: "runtime-data",
					identity: "module",
					effects: NO_EFFECT_SUMMARY,
				},
			})),
			{
				name: "poolEntry",
				type: { kind: "signature", source: "{ readonly href: string }" },
				description: "The task-pool bootstrap entry.",
				contract: {
					phase: "runtime",
					value: "runtime-data",
					identity: "module",
					effects: NO_EFFECT_SUMMARY,
					declaration: "worker-entry",
					workerSource: "workers/pool-worker.ts",
				},
			},
		],
	},
	{
		kind: "native",
		id: "maligator:process",
		stability: "experimental",
		evaluation: "side-effect-free",
		installer: "mal_host_install_maligator_process",
		declarationFile: "process-api.d.ts",
		description:
			"Read the compile-time command, target, and resolved application configuration. No surface flag is required. Runtime arguments, environment, working directory, and PID are separate process values.",
		types: executionTypes,
		exports: [
			{
				name: "execution",
				type: reference("Execution"),
				description:
					"An immutable snapshot of the workflow, target, and resolved configuration, fixed before compilation. Known property reads can specialize application branches. Runtime arguments, environment, working directory, and PID are outside this snapshot. Profiling does not change production intent. Static and dynamic imports share its identity, and reflection sees the complete deeply frozen shape.",
				examples: [
					'import { execution } from "maligator:process";\n\nif (execution.compiled && execution.production) {\n  console.log("native production application");\n}',
					'import { execution } from "maligator:process";\n\nif (execution.command === "test") {\n  console.log(execution.options.repeat);\n}',
				],
				contract: {
					phase: "preparation",
					value: "deep-frozen-data",
					identity: "application-context",
					provider: "execution",
					effects: NO_EFFECT_SUMMARY,
				},
			},
		],
	},

	{
		kind: "source",
		id: "maligator:test",
		stability: "experimental",
		evaluation: "side-effect-free",
		sourceFile: "testing/runtime.mjs",
		declarationFile: "test-api.d.ts",
		description:
			"Test authoring and assertions. Importing this module does not register tests or install runner globals. Registration and assertions are ordinary effectful calls; the test command initializes its internal runner explicitly. Unused imports can be eliminated.",
		types: [
			{
				name: "TestCallback",
				type: {
					kind: "signature",
					source: "() => unknown",
				},
				description:
					"A test or hook body. Maligator waits for a returned promise or thenable before advancing the lifecycle.",
			},
			{
				name: "HookCallback",
				type: {
					kind: "signature",
					source: "TestCallback",
				},
				description:
					"A lifecycle hook body, with the same async completion contract as a test.",
			},
			{
				name: "Constructor",
				type: {
					kind: "signature",
					source: "abstract new (...args: Array<never>) => unknown",
				},
				description: "A constructable value accepted by {@link expect.any}.",
			},
			{
				name: "AsymmetricMatcher",
				type: {
					kind: "signature",
					source: "{\n\t\treadonly __maligator_asymmetric__: string;\n\t}",
				},
				description:
					"Opaque partial-match value produced by helpers such as {@link expect.objectContaining}. It may be nested inside `toEqual`, `toStrictEqual`, and `toMatchObject` expectations.",
			},
			{
				name: "Matchers",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Negate the following matcher. */\n\t\treadonly not: Matchers;\n\t\t/** Wait for the received promise to fulfill, then match its value. */\n\t\treadonly resolves: AsyncMatchers;\n\t\t/** Wait for the received promise to reject, then match its reason. */\n\t\treadonly rejects: AsyncMatchers;\n\t\t/** Require ECMAScript `Object.is` identity. */\n\t\ttoBe(expected: unknown): void;\n\t\t/** Recursively compare enumerable object properties and array elements. */\n\t\ttoEqual(expected: unknown): void;\n\t\t/**\n\t\t * Recursively compare values while also requiring matching prototypes and\n\t\t * matching sparse-array holes.\n\t\t */\n\t\ttoStrictEqual(expected: unknown): void;\n\t\t/** Require a value other than `undefined`. */\n\t\ttoBeDefined(): void;\n\t\t/** Require `undefined`. */\n\t\ttoBeUndefined(): void;\n\t\t/** Require `null`. */\n\t\ttoBeNull(): void;\n\t\t/** Require a truthy value. */\n\t\ttoBeTruthy(): void;\n\t\t/** Require a falsy value. */\n\t\ttoBeFalsy(): void;\n\t\t/** Require a string substring or an array element matched by identity. */\n\t\ttoContain(expected: unknown): void;\n\t\t/** Require a numeric `.length` equal to `expected`. */\n\t\ttoHaveLength(expected: number): void;\n\t\t/** Match a string against a substring or regular expression. */\n\t\ttoMatch(expected: string | RegExp): void;\n\t\t/** Recursively require the enumerable properties present in `expected`. */\n\t\ttoMatchObject(expected: object): void;\n\t\t/**\n\t\t * Invoke the received function and require it to throw. The optional\n\t\t * expectation may be a message substring, regular expression, error\n\t\t * constructor, or error instance.\n\t\t */\n\t\ttoThrow(\n\t\t\texpected?:\n\t\t\t\t| string\n\t\t\t\t| RegExp\n\t\t\t\t| Error\n\t\t\t\t| (abstract new (...args: Array<never>) => Error),\n\t\t): void;\n\t}",
				},
				description: "Matchers for a synchronously received value.",
			},
			{
				name: "AsyncMatchers",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Negate the following asynchronous matcher. */\n\t\treadonly not: AsyncMatchers;\n\t\ttoBe(expected: unknown): Promise<void>;\n\t\ttoEqual(expected: unknown): Promise<void>;\n\t\ttoStrictEqual(expected: unknown): Promise<void>;\n\t\ttoBeDefined(): Promise<void>;\n\t\ttoBeUndefined(): Promise<void>;\n\t\ttoBeNull(): Promise<void>;\n\t\ttoBeTruthy(): Promise<void>;\n\t\ttoBeFalsy(): Promise<void>;\n\t\ttoContain(expected: unknown): Promise<void>;\n\t\ttoHaveLength(expected: number): Promise<void>;\n\t\ttoMatch(expected: string | RegExp): Promise<void>;\n\t\ttoMatchObject(expected: object): Promise<void>;\n\t\ttoThrow(\n\t\t\texpected?:\n\t\t\t\t| string\n\t\t\t\t| RegExp\n\t\t\t\t| Error\n\t\t\t\t| (abstract new (...args: Array<never>) => Error),\n\t\t): Promise<void>;\n\t}",
				},
				description:
					"Promise-returning matcher surface exposed by {@link Matchers.resolves} and {@link Matchers.rejects}. Await these calls so the test cannot finish before the assertion.",
			},
			{
				name: "ExpectFunction",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Create matchers for `received`. The assertion position is captured here. */\n\t\t(received: unknown): Matchers;\n\t\t/** Match a primitive of the corresponding built-in kind or an instance. */\n\t\tany(constructorValue: Constructor): AsymmetricMatcher;\n\t\t/** Match any value except `null` and `undefined`. */\n\t\tanything(): AsymmetricMatcher;\n\t\t/** Match a string containing `pattern` or satisfying the regular expression. */\n\t\tstringMatching(pattern: string | RegExp): AsymmetricMatcher;\n\t\t/** Match an object containing all recursively matched properties in `value`. */\n\t\tobjectContaining(value: object): AsymmetricMatcher;\n\t\t/** Match an array containing a match for every element in `value`. */\n\t\tarrayContaining(value: Array<unknown>): AsymmetricMatcher;\n\t}",
				},
				description:
					"Assertion entrypoint and Maligator-owned asymmetric matcher factories.",
			},
			{
				name: "TestFunction",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Register a test. Returned promises are awaited by the runner. */\n\t\t(name: string, callback: TestCallback): void;\n\t\t/** Register a skipped test without invoking its callback. */\n\t\tskip(name: string, callback: TestCallback): void;\n\t\t/** Register a named placeholder with no callback. */\n\t\ttodo(name: string): void;\n\t\t/**\n\t\t * Register a focused test. When any `.only` exists, non-focused tests are\n\t\t * skipped and the runner emits a warning.\n\t\t */\n\t\tonly(name: string, callback: TestCallback): void;\n\t\t/**\n\t\t * Register one test for each row. Use `%#` in `name` for the zero-based row\n\t\t * index. Array rows are spread into callback parameters.\n\t\t */\n\t\teach<const Row extends ReadonlyArray<unknown>>(\n\t\t\trows: ReadonlyArray<Row>,\n\t\t): (name: string, callback: (...values: [...Row]) => unknown) => void;\n\t}",
				},
				description: "Register tests in the current suite during module evaluation.",
			},
			{
				name: "DescribeFunction",
				type: {
					kind: "signature",
					source:
						"{\n\t\t/** Register a suite. Suite callbacks must not return a promise. */\n\t\t(name: string, callback: () => void): void;\n\t\t/** Register a suite whose descendants are skipped. */\n\t\tskip(name: string, callback: () => void): void;\n\t\t/** Register a focused suite and emit the runner's focused-test warning. */\n\t\tonly(name: string, callback: () => void): void;\n\t}",
				},
				description: "Register nested suites synchronously during module evaluation.",
			},
		],
		exports: [
			{
				name: "test",
				type: {
					kind: "reference",
					name: "TestFunction",
				},
				description: "Register a test in the current suite.",
			},
			{
				name: "describe",
				type: {
					kind: "reference",
					name: "DescribeFunction",
				},
				description: "Register a nested suite in the current suite.",
			},
			{
				name: "expect",
				type: {
					kind: "reference",
					name: "ExpectFunction",
				},
				description: "Create fluent matchers for a received value.",
			},
			{
				name: "beforeAll",
				type: {
					kind: "signature",
					source: "(callback: HookCallback) => void",
				},
				description: "Run once before tests in the current suite.",
			},
			{
				name: "afterAll",
				type: {
					kind: "signature",
					source: "(callback: HookCallback) => void",
				},
				description:
					"Run once after tests in the current suite, including after test failures.",
			},
			{
				name: "beforeEach",
				type: {
					kind: "signature",
					source: "(callback: HookCallback) => void",
				},
				description:
					"Run before every selected descendant test. Ancestor hooks run before hooks\ndeclared by a nested suite.",
			},
			{
				name: "afterEach",
				type: {
					kind: "signature",
					source: "(callback: HookCallback) => void",
				},
				description:
					"Run after every selected descendant test. Nested-suite hooks run before\nancestor hooks.",
			},
		].map((entry): PlatformExport => ({
			...entry,
			type: entry.type as PlatformType,
			contract: {
				phase: "runtime",
				value: "callable",
				identity: "module",
				effects: EVERY_EFFECT_SUMMARY,
			},
		})),
	},
];

export function lookupPlatformModule(specifier: string): PlatformModule | undefined {
	return PLATFORM_MODULES.find((module) => module.id === specifier);
}

/** Validate provider data against the same schema that generates the public types. */
export function validatePlatformValue(
	module: PlatformModule,
	type: PlatformType,
	value: unknown,
): value is PlatformData {
	switch (type.kind) {
		case "signature":
			return false;
		case "primitive":
			return (
				typeof value === type.name && (type.name !== "number" || Number.isFinite(value))
			);
		case "literal":
			return value === type.value;
		case "reference": {
			const definition = module.types.find((entry) => entry.name === type.name);
			if (!definition) throw new Error(`Unknown platform type ${module.id}/${type.name}`);
			return validatePlatformValue(module, definition.type, value);
		}
		case "array":
			return (
				Array.isArray(value) &&
				value.every((item: unknown) => validatePlatformValue(module, type.element, item))
			);
		case "record":
			return (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				Object.values(value).every((item: unknown) =>
					validatePlatformValue(module, type.value, item),
				)
			);
		case "object":
			return (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				type.properties.every(
					(entry) =>
						Object.hasOwn(value, entry.name) &&
						validatePlatformValue(
							module,
							entry.type,
							(value as Record<string, unknown>)[entry.name],
						),
				)
			);
		case "union":
			return type.types.some((entry) => validatePlatformValue(module, entry, value));
		case "intersection":
			return type.types.every((entry) => validatePlatformValue(module, entry, value));
	}
}
