import { describe, expect, it } from "vitest";
import type { TestCommandSummary } from "../src/testing/command.ts";
import type { TestGenerationControls } from "../src/testing/session.ts";
import { createTestWatchSession } from "../src/testing/watch.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

const summary: TestCommandSummary = {
	exitCode: 0,
	files: 1,
	passed: 1,
	failed: 0,
	skipped: 0,
	todo: 0,
	discoveryMs: 0,
	frontendMs: 0,
	executionMs: 0,
	cacheHits: 1,
	cacheMisses: 0,
	artifactHits: 1,
	artifactMisses: 0,
};

function harness() {
	const requests: Array<{
		controls: TestGenerationControls;
		failedOnly: boolean;
		result: ReturnType<typeof deferred<TestCommandSummary>>;
	}> = [];
	const started: Array<ReturnType<typeof deferred<void>>> = [];
	const published: Array<number> = [];
	let closes = 0;
	const session = createTestWatchSession(
		(controls, failedOnly) => {
			const result = deferred<TestCommandSummary>();
			requests.push({ controls, failedOnly, result });
			started[requests.length - 1]?.resolve();
			return result.promise;
		},
		{
			publish(_result, generation) {
				published.push(generation);
			},
			failed() {},
			close() {
				closes++;
			},
		},
	);
	return {
		requests,
		published,
		session,
		get closes() {
			return closes;
		},
		next(index: number) {
			if (requests[index] !== undefined) return Promise.resolve();
			const gate = deferred<void>();
			started[index] = gate;
			return gate.promise;
		},
	};
}

describe("persistent test watch generations", () => {
	it("drains admitted tests and releases images when shutdown observation throws", async () => {
		const started = deferred<TestGenerationControls>();
		const result = deferred<TestCommandSummary>();
		const failure = new Error("status output unavailable");
		let closed = false;
		const session = createTestWatchSession(
			(controls) => {
				started.resolve(controls);
				return result.promise;
			},
			{
				publish() {
					throw new Error("cancelled generation published");
				},
				failed() {},
				close() {
					closed = true;
				},
				event(event) {
					if (event.phase === "stopping") throw failure;
				},
			},
		);
		session.request();
		const controls = await started.promise;
		const closing = session.close();
		const rejected = expect(closing).rejects.toBe(failure);
		expect(controls.signal?.aborted).toBe(true);
		expect(closed).toBe(false);
		result.resolve(summary);
		await rejected;
		expect(closed).toBe(true);
		expect(session.close()).toBe(closing);
	});

	it("retains both shutdown observer failures after releasing images", async () => {
		const stopping = new Error("stopping observer");
		const stopped = new Error("stopped observer");
		let closed = false;
		const session = createTestWatchSession(() => Promise.resolve(summary), {
			publish() {},
			failed() {},
			close() {
				closed = true;
			},
			event(event) {
				if (event.phase === "stopping") throw stopping;
				if (event.phase === "stopped") throw stopped;
			},
		});
		await expect(session.close()).rejects.toMatchObject({ errors: [stopping, stopped] });
		expect(closed).toBe(true);
	});

	it("coalesces edits, retains invalidation, and discards stale results before publication", async () => {
		const current = harness();
		current.session.request();
		await current.next(0);
		current.session.request(["leaf-a"]);
		current.session.request(["leaf-b"], true);
		current.session.request([], false, true);
		expect(current.requests[0]?.controls.signal?.aborted).toBe(true);
		current.requests[0]!.result.resolve(summary);
		await current.next(1);
		expect(current.requests).toHaveLength(2);
		expect(current.requests[1]?.controls).toMatchObject({
			generation: 4,
			invalidatedPaths: ["leaf-a", "leaf-b"],
			invalidateAll: true,
		});
		expect(current.requests[1]?.failedOnly).toBe(false);
		current.requests[1]!.result.resolve(summary);
		await current.session.settled();
		expect(current.published).toEqual([4]);
		current.session.request([], false, true);
		await current.next(2);
		expect(current.requests[2]?.controls).toMatchObject({
			invalidatedPaths: [],
			invalidateAll: false,
		});
		expect(current.requests[2]?.failedOnly).toBe(true);
		current.requests[2]!.result.resolve(summary);
		await current.session.settled();
		await current.session.close();
	});

	it("preserves an observer's new invalidation without publishing its superseded summary", async () => {
		const next = deferred<TestGenerationControls>();
		const second = deferred<TestCommandSummary>();
		const published: Array<number> = [];
		const session = createTestWatchSession(
			(controls) => {
				if (controls.generation === 1) return Promise.resolve(summary);
				next.resolve(controls);
				return second.promise;
			},
			{
				publish(_result, generation) {
					published.push(generation);
				},
				failed() {},
				close() {},
				event(event) {
					if (event.generation === 1 && event.phase === "passed")
						session.request(["observer-edited.mts"], true);
				},
			},
		);
		session.request();
		expect(await next.promise).toMatchObject({
			generation: 2,
			invalidatedPaths: ["observer-edited.mts"],
			invalidateAll: true,
		});
		expect(published).toEqual([]);
		second.resolve(summary);
		await session.settled();
		expect(published).toEqual([2]);
		await session.close();
	});

	it("suppresses old error delivery when its failure observer requests a newer run", async () => {
		const next = deferred<TestGenerationControls>();
		const second = deferred<TestCommandSummary>();
		const delivered: Array<unknown> = [];
		const published: Array<number> = [];
		const session = createTestWatchSession(
			(controls) => {
				if (controls.generation === 1)
					return Promise.reject(new Error("old compilation error"));
				next.resolve(controls);
				return second.promise;
			},
			{
				publish(_result, generation) {
					published.push(generation);
				},
				failed(error) {
					delivered.push(error);
				},
				close() {},
				event(event) {
					if (event.generation === 1 && event.phase === "failed")
						session.request(["observer-edited.mts"], true);
				},
			},
		);
		session.request(["first.mts"]);
		expect(await next.promise).toMatchObject({
			generation: 2,
			invalidatedPaths: ["first.mts", "observer-edited.mts"],
			invalidateAll: true,
		});
		expect(delivered).toEqual([]);
		second.resolve(summary);
		await session.settled();
		expect(published).toEqual([2]);
		await session.close();
	});

	it("does not publish a summary after its passed observer closes the session", async () => {
		const published: Array<number> = [];
		let closing: Promise<void> | undefined;
		let closed = false;
		const session = createTestWatchSession(() => Promise.resolve(summary), {
			publish(_result, generation) {
				published.push(generation);
			},
			failed() {},
			close() {
				closed = true;
			},
			event(event) {
				if (event.phase === "passed") closing = session.close();
			},
		});
		session.request();
		await session.settled();
		expect(closing).toBeDefined();
		await closing;
		expect(closed).toBe(true);
		expect(published).toEqual([]);
	});

	it("aborts and drains accepted work before releasing cached images and drops pending runs", async () => {
		const current = harness();
		current.session.request();
		await current.next(0);
		current.session.request(["pending"]);
		const closing = current.session.close();
		expect(current.session.close()).toBe(closing);
		expect(current.requests[0]?.controls.signal?.aborted).toBe(true);
		expect(current.closes).toBe(0);
		current.requests[0]!.result.resolve(summary);
		await closing;
		expect(current.closes).toBe(1);
		expect(current.requests).toHaveLength(1);
		expect(current.published).toEqual([]);
		expect(() => current.session.request()).toThrow("stopping");
	});

	it("bounds diagnostic history across unchanged fresh reruns", async () => {
		const current = harness();
		for (let index = 0; index < 20; index++) {
			current.session.request();
			await current.next(index);
			current.requests[index]!.result.resolve(summary);
			await current.session.settled();
		}
		expect(current.session.snapshot().events).toHaveLength(32);
		expect(current.session.snapshot().completedGeneration).toBe(20);
		await current.session.close();
	});
});
