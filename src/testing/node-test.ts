import assert from "node:assert";
import process from "node:process";

interface TestOptions {
	name?: string;
	fn?: Callback;
	plan?: number;
	skip?: boolean | string;
	todo?: boolean | string;
	only?: boolean;
	concurrency?: boolean | number;
	timeout?: number;
	signal?: AbortSignal;
}

interface TestContext {
	name: string;
	signal: AbortSignal;
	assert: Record<string, (...args: Array<unknown>) => unknown>;
	plan(value: number, options?: { wait?: boolean | number }): void;
	after(callback: Callback, options?: unknown): void;
	test(): never;
	diagnostic(message: unknown): void;
}

type Callback = (context: TestContext | undefined) => unknown;
type HookKind = "before" | "after" | "beforeEach" | "afterEach";

interface Registration {
	name: string;
	options: TestOptions;
	fn: Callback | undefined;
}

interface TestRecord extends Registration {
	kind: "test";
	complete: () => void;
}

interface Suite {
	kind: "suite";
	name: string;
	children: Array<TestRecord | Suite>;
	before: Array<Callback>;
	after: Array<Callback>;
	beforeEach: Array<Callback>;
	afterEach: Array<Callback>;
}

const root = makeSuite("");
let collecting = root;
let scheduled = false;
let running = false;
let activeCancel: ((reason: unknown) => void) | undefined;

function unsupported(feature: string): Error {
	return Object.assign(new Error(`node:test does not support ${feature} yet`), {
		code: "ERR_NOT_IMPLEMENTED",
	});
}

function makeSuite(name: string): Suite {
	return {
		kind: "suite",
		name,
		children: [],
		before: [],
		after: [],
		beforeEach: [],
		afterEach: [],
	};
}

function argumentsFor(name: unknown, rawOptions: unknown, fn: unknown): Registration {
	if (typeof name === "function") return argumentsFor(name.name, {}, name);
	if (typeof name === "object" && name !== null)
		return argumentsFor(undefined, name, rawOptions);
	if (typeof rawOptions === "function") return argumentsFor(name, {}, rawOptions);
	if (rawOptions !== undefined && (rawOptions === null || typeof rawOptions !== "object"))
		throw new TypeError("Test options must be an object");
	const options = (rawOptions ?? {}) as TestOptions;
	if (options.fn !== undefined) fn = options.fn;
	if (options.name !== undefined) name = options.name;
	if (fn !== undefined && typeof fn !== "function")
		throw new TypeError("Test callback must be a function");
	if (typeof fn === "function" && fn.length > 1)
		throw unsupported("callback-style tests");
	if (options.concurrency && options.concurrency !== 1)
		throw unsupported("concurrent tests");
	if (options.only) throw unsupported("exclusive test selection");
	if (
		options.timeout !== undefined &&
		options.timeout !== Infinity &&
		(typeof options.timeout !== "number" ||
			!Number.isFinite(options.timeout) ||
			options.timeout < 0)
	)
		throw new RangeError("Test timeout must be a non-negative number");
	if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
		throw new TypeError("Test signal must be an AbortSignal");
	if (
		options.plan !== undefined &&
		(!Number.isSafeInteger(options.plan) || options.plan < 0)
	)
		throw new TypeError("The plan must be a non-negative integer");
	if (name !== undefined && typeof name !== "string")
		throw new TypeError("Test name must be a string");
	return {
		name: name ?? (typeof fn === "function" ? fn.name : "<anonymous>"),
		options,
		fn: fn as Callback | undefined,
	};
}

function schedule(): void {
	if (scheduled || running) return;
	scheduled = true;
	queueMicrotask(() => {
		scheduled = false;
		running = true;
		process.on("beforeExit", cancelIdle);
		void runSuite(root, [])
			.catch(reportFailure)
			.finally(() => {
				process.removeListener("beforeExit", cancelIdle);
				running = false;
				if (root.children.length > 0) schedule();
			});
	});
}

function cancelIdle(): void {
	activeCancel?.(
		new Error(
			"Promise resolution is still pending but the event loop has already resolved",
		),
	);
}

function reportFailure(error: unknown): void {
	process.exitCode ||= 1;
	process.stderr.write(
		`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
	);
}

async function phase(fn: Callback, context: TestContext | undefined): Promise<unknown> {
	let cancel: ((reason: unknown) => void) | undefined;
	const cancelled = new Promise<never>((_resolve, reject) => {
		cancel = reject;
	});
	activeCancel = cancel;
	try {
		return await Promise.race([Promise.resolve().then(() => fn(context)), cancelled]);
	} finally {
		if (activeCancel === cancel) activeCancel = undefined;
	}
}

async function hooks(
	callbacks: Array<Callback>,
	context: TestContext | undefined,
	checkCancellation = false,
): Promise<void> {
	for (const callback of callbacks) {
		if (checkCancellation) context?.signal.throwIfAborted();
		await phase(callback, context);
	}
}

function cancelPending(suite: Suite): void {
	for (const child of suite.children.splice(0)) {
		if (child.kind === "suite") cancelPending(child);
		else child.complete();
	}
}

async function runSuite(suite: Suite, ancestors: Array<Suite>): Promise<void> {
	const lineage = [...ancestors, suite];
	try {
		await hooks(suite.before, undefined);
		while (suite.children.length > 0) {
			const child = suite.children.shift()!;
			if (child.kind === "suite") await runSuite(child, lineage);
			else await runTest(child, lineage);
		}
	} catch (error) {
		reportFailure(error);
		cancelPending(suite);
	} finally {
		try {
			await hooks(suite.after, undefined);
		} catch (error) {
			reportFailure(error);
		}
	}
}

async function runTest(record: TestRecord, ancestors: Array<Suite>): Promise<void> {
	const { name, options, fn } = record;
	if (options.skip || fn === undefined) {
		process.stdout.write(`ok - ${JSON.stringify(name)} # SKIP\n`);
		record.complete();
		return;
	}
	const controller = new AbortController();
	const cleanup: Array<Callback> = [];
	let count = 0;
	let expected: number | undefined = options.plan;
	const failures: Array<unknown> = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	const context: TestContext = {
		name,
		signal: controller.signal,
		assert: {},
		plan(value, planOptions = {}) {
			if (expected !== undefined)
				throw new Error("The test already has an assertion plan");
			if (!Number.isSafeInteger(value) || value < 0)
				throw new TypeError("The plan must be a non-negative integer");
			if (planOptions.wait) throw unsupported("waiting assertion plans");
			expected = value;
		},
		after(callback, hookOptions) {
			if (typeof callback !== "function")
				throw new TypeError("After hook must be a function");
			if (callback.length > 1 || hookOptions !== undefined)
				throw unsupported("callback hooks or hook options");
			cleanup.push(callback);
		},
		test() {
			throw unsupported("nested tests");
		},
		diagnostic(message) {
			process.stdout.write(`# ${String(message)}\n`);
		},
	};
	for (const [key, method] of Object.entries(assert)) {
		if (typeof method !== "function" || ["Assert", "CallTracker", "strict"].includes(key))
			continue;
		context.assert[key] = (...args) => {
			count++;
			return Reflect.apply(
				method as (...values: Array<unknown>) => unknown,
				assert,
				args,
			);
		};
	}
	const cancel = (reason: unknown): void => {
		controller.abort(reason);
		activeCancel?.(reason);
	};
	const abort = (): void => cancel(options.signal?.reason);
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.timeout !== undefined && options.timeout !== Infinity) {
		timer = setTimeout(
			() => cancel(new Error(`Test timed out after ${options.timeout}ms`)),
			options.timeout,
		);
		timer.unref();
	}
	try {
		if (options.signal?.aborted) {
			throw options.signal.reason;
		}
		await hooks(
			ancestors.flatMap((suite) => suite.beforeEach),
			context,
			true,
		);
		controller.signal.throwIfAborted();
		await phase(fn, context);
		if (expected !== undefined)
			assert.strictEqual(
				count,
				expected,
				`Expected ${expected} assertions, received ${count}`,
			);
	} catch (error) {
		failures.push(error);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
		try {
			await hooks(
				[...ancestors].reverse().flatMap((suite) => suite.afterEach),
				context,
			);
		} catch (error) {
			failures.push(error);
		}
		try {
			await hooks(cleanup, context);
		} catch (error) {
			failures.push(error);
		}
		controller.abort();
	}
	if (failures.length > 0 && !options.todo) {
		process.stdout.write(`not ok - ${JSON.stringify(name)}\n`);
		for (const error of failures) reportFailure(error);
	} else
		process.stdout.write(
			`ok - ${JSON.stringify(name)}${options.todo ? " # TODO" : ""}\n`,
		);
	record.complete();
}

function registerTest(name?: unknown, options?: unknown, fn?: unknown): Promise<void> {
	if (running && collecting === root)
		throw unsupported("test registration from an active test");
	const record = argumentsFor(name, options, fn);
	let complete: () => void;
	const completion = new Promise<void>((resolve) => {
		complete = resolve;
	});
	collecting.children.push({ ...record, kind: "test", complete: complete! });
	schedule();
	return collecting === root ? completion : Promise.resolve();
}

function registerSuite(name?: unknown, options?: unknown, fn?: unknown): Promise<void> {
	const record = argumentsFor(name, options, fn);
	if (record.options.skip || record.fn === undefined) return Promise.resolve();
	if (
		record.options.todo ||
		record.options.timeout !== undefined ||
		record.options.signal !== undefined
	)
		throw unsupported("suite options other than skip");
	const suite = makeSuite(record.name);
	const previous = collecting;
	collecting.children.push(suite);
	collecting = suite;
	try {
		const result = record.fn(undefined);
		if (result && typeof (result as PromiseLike<unknown>).then === "function") {
			void Promise.resolve(result).catch(() => {});
			throw unsupported("asynchronous suite collection");
		}
	} finally {
		collecting = previous;
	}
	schedule();
	return Promise.resolve();
}

function addHook(kind: HookKind, callback: Callback, options: unknown): void {
	if (typeof callback !== "function") throw new TypeError("Hook must be a function");
	if (callback.length > 1 || options !== undefined)
		throw unsupported("callback hooks or hook options");
	collecting[kind].push(callback);
}

export function before(callback: Callback, options?: unknown): void {
	addHook("before", callback, options);
}
export function after(callback: Callback, options?: unknown): void {
	addHook("after", callback, options);
}
export function beforeEach(callback: Callback, options?: unknown): void {
	addHook("beforeEach", callback, options);
}
export function afterEach(callback: Callback, options?: unknown): void {
	addHook("afterEach", callback, options);
}

function decorate(register: typeof registerTest) {
	return Object.assign(register, {
		skip(name?: unknown, options?: unknown, fn?: unknown): Promise<void> {
			const record = argumentsFor(name, options, fn);
			return register(record.name, { ...record.options, skip: true }, record.fn);
		},
		todo(name?: unknown, options?: unknown, fn?: unknown): Promise<void> {
			const record = argumentsFor(name, options, fn);
			return register(record.name, { ...record.options, todo: true }, record.fn);
		},
		only(): never {
			throw unsupported("exclusive test selection");
		},
	});
}

export const test = decorate(registerTest);
export const describe = decorate(registerSuite);
export const it = test;
export const suite = describe;
Object.assign(test, { test, it, describe, suite, before, after, beforeEach, afterEach });
// oxlint-disable-next-line import/no-default-export -- node:test requires a callable default export.
export { test as default, test as "module.exports" };
