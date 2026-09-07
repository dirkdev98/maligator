import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileExplorer } from "../src/explorer/api.ts";
import { ExplorerClient } from "../src/explorer/browser-client.ts";
import { EXPLORER_LIMITS, EXPLORER_SCHEMA } from "../src/explorer/config.ts";
import type {
	ExplorerSiteData,
	ExplorerWorkerRequest,
	ExplorerWorkerResponse,
} from "../src/explorer/protocol.ts";

const result = compileExplorer("globalThis.answer = 42");
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const data: ExplorerSiteData = {
	schema: EXPLORER_SCHEMA,
	identity: "compiler-a",
	version: "test",
	wasmUrl: "/compiler.wasm",
	wasmBytes: 1,
	compressedBytes: 1,
	workerUrl: "/worker.js",
	samples: [],
};
class ControlledWorker {
	static instances: Array<ControlledWorker> = [];
	onmessage?: (event: { data: ExplorerWorkerResponse }) => void;
	onerror?: () => void;
	onmessageerror?: () => void;
	messages: Array<ExplorerWorkerRequest> = [];
	terminated = false;
	finishedId = -1;
	constructor() {
		ControlledWorker.instances.push(this);
	}
	postMessage(message: ExplorerWorkerRequest): void {
		this.messages.push(message);
	}
	terminate(): void {
		this.terminated = true;
	}
	send(message: ExplorerWorkerResponse): void {
		this.onmessage?.({ data: message });
	}
	ready(): void {
		this.send({
			type: "ready",
			identity: data.identity,
			module,
			milliseconds: 1,
			memoryBytes: 1024,
		});
	}
	finish(memoryBytes = 1024): void {
		const request = this.messages.at(-1);
		if (request?.type !== "compile") throw new Error("No compile request");
		this.finishedId = request.id;
		this.send({
			type: "result",
			id: request.id,
			identity: data.identity,
			response: { ok: true, result },
			milliseconds: 1,
			memoryBytes,
		});
	}
}
let client: ExplorerClient;
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.stubGlobal("Worker", ControlledWorker);
	ControlledWorker.instances = [];
	client = new ExplorerClient(data, () => {});
});
afterEach(() => {
	client.dispose();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
async function pendingWorker(): Promise<ControlledWorker> {
	await vi.waitFor(() => expect(ControlledWorker.instances.length).toBeGreaterThan(0));
	const worker = ControlledWorker.instances.at(-1)!;
	if (worker.messages.at(-1)?.type === "init") worker.ready();
	await vi.waitFor(() => {
		const request = worker.messages.at(-1);
		expect(request?.type).toBe("compile");
		if (request?.type === "compile") expect(request.id).not.toBe(worker.finishedId);
	});
	return worker;
}
async function compile(source: string, config: unknown = {}): Promise<void> {
	const promise = client.compile(source, config);
	(await pendingWorker()).finish();
	expect((await promise).cached).toBe(false);
}

describe("browser compiler lifecycle", () => {
	it("deduplicates pending work and keys cached results by exact source and normalized settings", async () => {
		const first = client.compile("source", {});
		expect(client.compile("source", {})).toBe(first);
		(await pendingWorker()).finish();
		await first;
		expect((await client.compile("source", { regexp: false })).cached).toBe(true);
		await compile("source ");
		await compile("source", { regexp: true });
		expect(
			ControlledWorker.instances[0]!.messages.filter((item) => item.type === "compile"),
		).toHaveLength(3);
	});
	it("separates JavaScript and TypeScript requests in the result cache", async () => {
		await compile("same source");
		const typed = client.compile("same source", {}, "typescript");
		const worker = await pendingWorker();
		expect(worker.messages.at(-1)).toMatchObject({ language: "typescript" });
		worker.finish();
		expect((await typed).cached).toBe(false);
		expect((await client.compile("same source", {}, "typescript")).cached).toBe(true);
		expect((await client.compile("same source", {}, "javascript")).cached).toBe(true);
	});

	it("cancels loading and active work, ignores an old worker, and reuses the compiled module", async () => {
		const first = client.compile("first", {});
		const rejected = expect(first).rejects.toMatchObject({ kind: "cancelled" });
		const old = await pendingWorker();
		client.cancel();
		await rejected;
		expect(old.terminated).toBe(true);
		const second = client.compile("second", {});
		await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(2));
		const fresh = ControlledWorker.instances[1]!;
		expect(fresh.messages[0]).toMatchObject({ type: "init", module });
		old.onerror?.();
		old.finish();
		fresh.ready();
		await vi.waitFor(() => expect(fresh.messages.at(-1)?.type).toBe("compile"));
		fresh.finish();
		expect((await second).cached).toBe(false);
	});
	it("times out stalled loading and compilation and accepts subsequent work", async () => {
		const first = client.compile("loading", {});
		const loadFailure = expect(first).rejects.toMatchObject({
			kind: "timeout",
		});
		await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(EXPLORER_LIMITS.loadMs);
		await loadFailure;
		const second = client.compile("compiling", {});
		const compileFailure = expect(second).rejects.toMatchObject({
			kind: "timeout",
		});
		await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(2));
		await pendingWorker();
		await vi.advanceTimersByTimeAsync(EXPLORER_LIMITS.compileMs);
		await compileFailure;
		const third = client.compile("recovered", {});
		await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(3));
		(await pendingWorker()).finish();
		expect((await third).cached).toBe(false);
	});
	it("evicts least-recently-used results and preserves cache across memory recycling", async () => {
		for (let i = 0; i < EXPLORER_LIMITS.cacheEntries; i++) await compile(`source-${i}`);
		expect((await client.compile("source-0", {})).cached).toBe(true);
		const next = client.compile("extra", {});
		const worker = await pendingWorker();
		worker.finish(EXPLORER_LIMITS.recycleBytes);
		await next;
		expect(worker.terminated).toBe(true);
		expect((await client.compile("source-0", {})).cached).toBe(true);
		const evicted = client.compile("source-1", {});
		await vi.waitFor(() => expect(ControlledWorker.instances).toHaveLength(2));
		(await pendingWorker()).finish();
		expect((await evicted).cached).toBe(false);
	});
	it("rejects source over the UTF-8 limit before starting a worker", async () => {
		await expect(
			client.compile("🐊".repeat(EXPLORER_LIMITS.sourceBytes / 4 + 1), {}),
		).rejects.toMatchObject({ kind: "limit" });
		expect(ControlledWorker.instances).toHaveLength(0);
	});
});
