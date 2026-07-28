import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { get } from "node:http";
import { createConnection } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	STRESS_ENV,
	waitForPort,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-http-ready-queues-"));
const HELD_COUNT = 48;
const CLOSE_COUNT = 24;

function field(line: string, name: string): number {
	const match = line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`));
	if (match === null) throw new Error(`missing ${name} in perf stats`);
	return Number(match[1]);
}

describe("node:http ready request queues", () => {
	let binary: string;

	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/node-http-ready-queues.cjs",
			name: "node-http-ready-queues",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	async function disconnectDuringWrite(port: number): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port }, () => {
				socket.write(
					"GET /write-error HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
				);
				setTimeout(() => {
					socket.destroy();
					resolve();
				}, 10);
			});
			socket.once("error", reject);
		});
	}

	async function getFresh(url: string): Promise<string> {
		return await new Promise<string>((resolve, reject) => {
			get(url, { agent: false }, (response) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => (body += chunk));
				response.on("end", () => resolve(body));
			}).once("error", reject);
		});
	}

	async function pipelineTwoRequests(port: number): Promise<string> {
		return await new Promise<string>((resolve, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port }, () => {
				socket.write(
					"GET /churn/pipe-a HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n" +
						"GET /churn/pipe-b HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
				);
			});
			let bytes = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => (bytes += chunk));
			socket.on("end", () => resolve(bytes));
			socket.once("error", reject);
			socket.setTimeout(5000, () => {
				socket.destroy();
				reject(new Error("pipelined requests timed out"));
			});
		});
	}

	async function runLifecycle(env: NodeJS.ProcessEnv): Promise<void> {
		const child = spawn(binary, [], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, MAL_PERF_STATS: "1", ...env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		const exit = new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("server did not exit")), 15000);
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});

		try {
			const port = await waitForPort(child);
			const base = `http://127.0.0.1:${port}`;
			const held = await Promise.all(
				Array.from({ length: HELD_COUNT }, (_, index) =>
					fetch(`${base}/held/${index}`).then((response) => response.text()),
				),
			);
			expect(held).toEqual(Array.from({ length: HELD_COUNT }, (_, index) => `${index}`));
			expect(await fetch(`${base}/held-status`).then((response) => response.text())).toBe(
				`${HELD_COUNT}:${HELD_COUNT}:true`,
			);

			await disconnectDuringWrite(port);
			for (let attempt = 0; attempt < 50; attempt++) {
				const status = await getFresh(`${base}/write-error-status`);
				if (status === "1:1") break;
				await new Promise<void>((resolve) => {
					setTimeout(resolve, 10);
				});
			}
			expect(await getFresh(`${base}/write-error-status`)).toBe("1:1");

			for (let round = 0; round < 5; round++) {
				const values = await Promise.all(
					Array.from({ length: 24 }, (_, index) =>
						fetch(`${base}/churn/${round}-${index}`).then((response) => response.text()),
					),
				);
				expect(values).toEqual(
					Array.from({ length: 24 }, (_, index) => `${round}-${index}`),
				);
			}
			const pipelined = await pipelineTwoRequests(port);
			expect(pipelined.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2);
			expect(pipelined.indexOf("pipe-a")).toBeLessThan(pipelined.indexOf("pipe-b"));

			const closing = await Promise.all(
				Array.from({ length: CLOSE_COUNT }, (_, index) =>
					fetch(`${base}/close-queued/${index}`).then((response) => response.text()),
				),
			);
			expect(closing).toEqual(
				Array.from({ length: CLOSE_COUNT }, (_, index) => `${index}`),
			);
			expect(await exit, stderr).toBe(0);
			const order = stdout.match(/ORDER ([^\n]+)/)?.[1]?.split(",") ?? [];
			expect(order).toHaveLength(CLOSE_COUNT + 1);
			expect(order.at(-1)).toBe("close");
			expect(order.slice(0, -1).every((entry) => entry.startsWith("finish:"))).toBe(true);
			const stats = stderr
				.split("\n")
				.find((line) => line.startsWith("[perf-http-stats]"));
			expect(stats).toBeDefined();
			const line = stats ?? "";
			expect(field(line, "request_state_scans")).toBe(0);
			expect(field(line, "close_request_state_scans")).toBe(0);
			expect(field(line, "request_remove_scans")).toBe(0);
			expect(field(line, "close_scans")).toBeGreaterThan(0);
			expect(field(line, "dispatch_enqueues")).toBeGreaterThan(0);
			expect(field(line, "completion_enqueues")).toBeGreaterThan(0);
			expect(field(line, "request_inserts")).toBeGreaterThan(0);
			expect(field(line, "dispatch_enqueues")).toBe(field(line, "dispatch_dequeues"));
			expect(field(line, "completion_enqueues")).toBe(field(line, "completion_dequeues"));
			expect(field(line, "request_inserts")).toBe(field(line, "request_removes"));
		} catch (error) {
			throw new Error(
				`${(error as Error).message}\nexit=${child.exitCode}\n${stdout}\n${stderr}`,
			);
		} finally {
			child.kill("SIGKILL");
		}
	}

	it("dispatches, completes, churns, and closes in lifecycle order", async () => {
		await runLifecycle({});
	});

	it("keeps queued request and response roots valid under GC stress", async () => {
		await runLifecycle(STRESS_ENV);
	});
});
