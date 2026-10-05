import { describe, expect, it } from "vitest";
import type { BuildCommandResult } from "../src/cli-commands.ts";
import type { DevCommand } from "../src/cli.ts";
import type { CompilationCommand, CompilationOptions } from "../src/compiler-service.ts";
import { createDevelopmentSession } from "../src/development-session.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const command: DevCommand = {
	kind: "dev",
	entry: "app.mts",
	verbose: false,
	profile: false,
	programArgs: [],
};

function compilerHarness() {
	type Request = {
		command: CompilationCommand;
		options: CompilationOptions;
		result: ReturnType<typeof deferred<BuildCommandResult>>;
	};
	const requests: Array<Request> = [];
	const unread: Array<Request> = [];
	const waiters: Array<(request: Request) => void> = [];
	return {
		requests,
		compiler: {
			prepare(input: CompilationCommand, options: CompilationOptions = {}) {
				const request = {
					command: input,
					options,
					result: deferred<BuildCommandResult>(),
				};
				requests.push(request);
				const waiter = waiters.shift();
				if (waiter === undefined) unread.push(request);
				else waiter(request);
				return request.result.promise;
			},
		},
		next(): Promise<Request> {
			const request = unread.shift();
			return request === undefined
				? new Promise((resolve) => {
						waiters.push(resolve);
					})
				: Promise.resolve(request);
		},
	};
}

function applicationHarness() {
	const published: Array<string | undefined> = [];
	const failures: Array<unknown> = [];
	let stops = 0;
	return {
		published,
		failures,
		get stops() {
			return stops;
		},
		host: {
			publish(result: BuildCommandResult, _generation: number, isCurrent: () => boolean) {
				if (!isCurrent()) return Promise.resolve(false);
				published.push(result.binaryPath);
				return Promise.resolve(true);
			},
			failed(error: unknown) {
				failures.push(error);
			},
			stop() {
				stops++;
				return Promise.resolve();
			},
		},
	};
}

describe("development generations", () => {
	it("drains admitted compilation and stops the application when shutdown observation throws", async () => {
		const compiler = compilerHarness();
		const application = applicationHarness();
		const failure = new Error("status output unavailable");
		const session = createDevelopmentSession(command, compiler.compiler, {
			...application.host,
			event(event) {
				if (event.phase === "stopping") throw failure;
			},
		});
		session.request();
		const request = await compiler.next();
		const closing = session.close();
		const rejected = expect(closing).rejects.toBe(failure);
		expect(request.options.signal?.aborted).toBe(true);
		expect(application.stops).toBe(0);
		request.result.resolve({ binaryPath: "superseded" });
		await rejected;
		expect(application.stops).toBe(1);
		expect(application.published).toEqual([]);
		expect(session.close()).toBe(closing);
	});

	it("retains shutdown observation and cleanup failures", async () => {
		const stopping = new Error("stopping observer");
		const cleanup = new Error("application cleanup");
		const session = createDevelopmentSession(command, compilerHarness().compiler, {
			...applicationHarness().host,
			event(event) {
				if (event.phase === "stopping") throw stopping;
			},
			stop() {
				return Promise.reject(cleanup);
			},
		});
		await expect(session.close()).rejects.toMatchObject({ errors: [stopping, cleanup] });
	});

	it("keeps application readiness distinct from evaluation while later compilation runs", async () => {
		const compiler = compilerHarness();
		const application = applicationHarness();
		const session = createDevelopmentSession(
			command,
			compiler.compiler,
			application.host,
		);
		session.request();
		(await compiler.next()).result.resolve({ binaryPath: "server" });
		await session.settled();
		session.observeApplication({ generation: 1, backend: "thread", state: "evaluated" });
		expect(session.snapshot().application?.state).toBe("evaluated");
		session.request(["leaf.mts"]);
		const compiling = await compiler.next();
		compiling.options.onPhase?.({ label: "Emit program", state: "started" });
		expect(session.snapshot().compilation).toEqual({
			label: "Emit program",
			state: "started",
		});
		session.observeApplication({ generation: 1, backend: "thread", state: "ready" });
		expect(session.snapshot()).toMatchObject({
			phase: "running",
			compilingGeneration: 2,
			application: { generation: 1, state: "ready" },
		});
		const closing = session.close();
		compiling.result.resolve({ binaryPath: "canceled" });
		await closing;
	});
	it("coalesces rapid edits and prevents stale successful compilation from publishing", async () => {
		const compiler = compilerHarness();
		const application = applicationHarness();
		const session = createDevelopmentSession(
			command,
			compiler.compiler,
			application.host,
		);
		session.request();
		const first = await compiler.next();
		session.request(["leaf-a.mts"]);
		session.request(["leaf-b.mts"], true);
		session.request(["leaf-a.mts"]);
		expect(first.options.signal?.aborted).toBe(true);
		first.options.onPhase?.({ label: "Stale phase", state: "completed" });
		expect(
			session
				.snapshot()
				.events.some((event) => event.compilation?.label === "Stale phase"),
		).toBe(false);
		expect(session.snapshot()).toMatchObject({
			compilingGeneration: 1,
			queuedGeneration: 4,
		});
		first.result.resolve({ binaryPath: "stale" });
		const newest = await compiler.next();
		expect(compiler.requests).toHaveLength(2);
		expect(newest.command).toBe(command);
		expect(newest.options).toMatchObject({
			compact: true,
			invalidatedPaths: ["leaf-a.mts", "leaf-b.mts"],
			invalidateAll: true,
		});
		newest.result.resolve({ binaryPath: "newest" });
		await session.settled();
		expect(application.published).toEqual(["newest"]);
		expect(session.snapshot()).toMatchObject({ phase: "active", activeGeneration: 4 });
		await session.close();
	});

	it("suppresses old error delivery when its failure observer requests a newer build", async () => {
		const compiler = compilerHarness();
		const application = applicationHarness();
		const session = createDevelopmentSession(command, compiler.compiler, {
			...application.host,
			event(event) {
				if (event.generation === 1 && event.phase === "failed")
					session.request(["observer-edited.mts"], true);
			},
		});
		session.request(["first.mts"]);
		(await compiler.next()).result.reject(new Error("old syntax error"));
		const newest = await compiler.next();
		expect(newest.options).toMatchObject({
			invalidatedPaths: ["first.mts", "observer-edited.mts"],
			invalidateAll: true,
		});
		expect(application.failures).toEqual([]);
		newest.result.resolve({ binaryPath: "newest" });
		await session.settled();
		expect(application.published).toEqual(["newest"]);
		await session.close();
	});

	it("retains the active application and outstanding invalidations after compilation fails", async () => {
		const compiler = compilerHarness();
		const application = applicationHarness();
		const session = createDevelopmentSession(
			command,
			compiler.compiler,
			application.host,
		);
		session.request();
		(await compiler.next()).result.resolve({ binaryPath: "last-good" });
		await session.settled();
		session.request(["broken.mts"]);
		(await compiler.next()).result.reject(new Error("syntax error"));
		await session.settled();
		expect(application.published).toEqual(["last-good"]);
		expect(application.stops).toBe(0);
		expect(application.failures).toHaveLength(1);
		expect(session.snapshot()).toMatchObject({ phase: "failed", activeGeneration: 1 });
		session.request(["fixed.mts"]);
		const fixed = await compiler.next();
		expect(fixed.options.invalidatedPaths).toEqual(["broken.mts", "fixed.mts"]);
		fixed.result.resolve({ binaryPath: "fixed" });
		await session.settled();
		expect(application.published).toEqual(["last-good", "fixed"]);
		await session.close();
	});

	it("continues watching after the first build fails and clears invalidation only on activation", async () => {
		const compiler = compilerHarness();
		const application = applicationHarness();
		const session = createDevelopmentSession(
			command,
			compiler.compiler,
			application.host,
		);
		session.request(["app.mts"], true);
		(await compiler.next()).result.reject(new Error("invalid first revision"));
		await session.settled();
		expect(session.snapshot()).toMatchObject({
			phase: "failed",
			activeGeneration: undefined,
		});
		expect(application.published).toEqual([]);
		session.request(["app.mts"]);
		(await compiler.next()).result.resolve({ binaryPath: "valid" });
		await session.settled();
		session.request(["later.mts"]);
		const later = await compiler.next();
		expect(later.options).toMatchObject({
			invalidatedPaths: ["later.mts"],
			invalidateAll: false,
		});
		later.result.resolve({ binaryPath: "later" });
		await session.settled();
		await session.close();
	});

	it("aborts and drains an active compilation before stopping the host and drops queued work", async () => {
		const compiler = compilerHarness();
		const application = applicationHarness();
		const session = createDevelopmentSession(
			command,
			compiler.compiler,
			application.host,
		);
		session.request();
		const first = await compiler.next();
		session.request(["pending.mts"]);
		let closed = false;
		const closing = session.close().then(() => {
			closed = true;
		});
		expect(first.options.signal?.aborted).toBe(true);
		expect(application.stops).toBe(0);
		expect(closed).toBe(false);
		first.result.resolve({ binaryPath: "too-late" });
		await closing;
		expect(application.published).toEqual([]);
		expect(compiler.requests).toHaveLength(1);
		expect(application.stops).toBe(1);
		expect(session.snapshot().phase).toBe("stopped");
		await session.close();
		expect(application.stops).toBe(1);
		expect(() => session.request()).toThrow("stopping");
	});

	it("lets a launch adapter reject a generation superseded during asynchronous publication", async () => {
		const compiler = compilerHarness();
		const application = applicationHarness();
		const publishing = deferred<void>();
		const release = deferred<void>();
		const session = createDevelopmentSession(command, compiler.compiler, {
			...application.host,
			async publish(result, generation, isCurrent) {
				if (generation === 1) {
					publishing.resolve();
					await release.promise;
				}
				return application.host.publish(result, generation, isCurrent);
			},
		});
		session.request();
		(await compiler.next()).result.resolve({ binaryPath: "stale-launch" });
		await publishing.promise;
		session.request(["new.mts"]);
		release.resolve();
		(await compiler.next()).result.resolve({ binaryPath: "current-launch" });
		await session.settled();
		expect(application.published).toEqual(["current-launch"]);
		await session.close();
	});

	it("keeps event history bounded while exposing the newest queue state", async () => {
		const compiler = compilerHarness();
		const application = applicationHarness();
		const session = createDevelopmentSession(
			command,
			compiler.compiler,
			application.host,
		);
		session.request();
		const first = await compiler.next();
		for (let index = 0; index < 100; index++) session.request([`change-${index}`]);
		const snapshot = session.snapshot();
		expect(snapshot.events).toHaveLength(32);
		expect(snapshot.events.at(-1)).toMatchObject({ generation: 101, phase: "queued" });
		first.result.resolve({ binaryPath: "discarded" });
		(await compiler.next()).result.resolve({ binaryPath: "latest" });
		await session.settled();
		expect(application.published).toEqual(["latest"]);
		await session.close();
	});
});
