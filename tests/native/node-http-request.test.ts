import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	STRESS_ENV,
	waitForPort,
	withServer,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-http-request-"));

describe("node:http request bridge", () => {
	let binaries: Array<string>;
	let instrumentedBinary: string;

	beforeAll(() => {
		binaries = [
			buildNativeBinary({
				fixture: "tests/local/node-http-request.cjs",
				name: "node-http-request-compiled",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
			}),
			buildNativeBinary({
				fixture: "tests/local/node-http-request.cjs",
				name: "node-http-request-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled: false,
			}),
		];
		instrumentedBinary = buildNativeBinary({
			fixture: "tests/local/node-http-request.cjs",
			name: "node-http-request-perf",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	function field(line: string, name: string): number {
		return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
	}

	async function checkBridge(base: string): Promise<void> {
		const metadata = await fetch(`${base}/metadata`, {
			headers: { "x-test": "request-header" },
		});
		expect(metadata.status).toBe(201);
		expect(metadata.headers.get("x-reply")).toBe("response-header");
		expect(await metadata.text()).toBe("ab");

		const echo = await fetch(`${base}/echo`, {
			method: "POST",
			body: "request-body",
		});
		expect(echo.status).toBe(200);
		expect(echo.headers.get("content-type")).toBe("text/plain");
		expect(await echo.text()).toBe("request-body");

		for (let round = 0; round < 4; round++) {
			const responses = await Promise.all(
				Array.from({ length: 16 }, (_, index) =>
					fetch(`${base}/concurrent/${round}-${index}`),
				),
			);
			for (let index = 0; index < responses.length; index++) {
				const response = responses[index]!;
				expect(response.status).toBe(200);
				expect(response.headers.get("x-index")).toBe(`${round}-${index}`);
				expect(await response.text()).toBe(`batch:${round}-${index}`);
			}
		}

		const receiverCheck = await fetch(`${base}/receiver-check`);
		expect(receiverCheck.status).toBe(200);
		expect(await receiverCheck.text()).toBe("ok");

		const asyncResponse = await fetch(`${base}/async`);
		expect(asyncResponse.headers.get("x-async")).toBe("yes");
		expect(await asyncResponse.text()).toBe("yes");

		for (let i = 0; i < 3; i++) {
			const response = await fetch(`${base}/metadata`, {
				headers: { "x-test": "request-header" },
			});
			expect(response.status).toBe(201);
			expect(await response.text()).toBe("ab");
		}

		const head = await fetch(`${base}/metadata`, {
			method: "HEAD",
			headers: { "x-test": "request-header" },
		});
		expect(head.status).toBe(201);
		expect(head.headers.get("content-length")).toBe("2");
		expect(await head.text()).toBe("");

		const noBody = await fetch(`${base}/no-body`);
		expect(noBody.status).toBe(204);
		expect(noBody.headers.get("content-length")).toBeNull();
		expect(await noBody.text()).toBe("");

		const reentrant = await fetch(`${base}/reentrant`);
		expect(reentrant.status).toBe(500);
		expect(await reentrant.text()).toBe("request handler error");

		const throwAfterEnd = await fetch(`${base}/throw-after-end`);
		expect(throwAfterEnd.status).toBe(200);
		expect(await throwAfterEnd.text()).toBe("already-ended");

		const connectionClose = await fetch(`${base}/connection-close`);
		expect(connectionClose.headers.get("connection")).toBe("close");
		expect(await connectionClose.text()).toBe("connection-closed");

		const afterClose = await fetch(`${base}/metadata`, {
			headers: { "x-test": "request-header" },
		});
		expect(afterClose.status).toBe(201);
		expect(await afterClose.text()).toBe("ab");

		const close = await fetch(`${base}/close`);
		expect(await close.text()).toBe("closed");
	}

	it("dispatches requests and writes responses in compiled and interpreted modes", async () => {
		for (const binary of binaries) {
			await withServer(binary, {}, checkBridge);
		}
	});

	it("keeps request and response state rooted under GC stress", async () => {
		await withServer(binaries[0]!, STRESS_ENV, checkBridge);
	});

	it("tracks indexed active response lifecycle", async () => {
		const child = spawn(instrumentedBinary, [], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, MAL_GC_AT_EXIT: "1", MAL_PERF_STATS: "1" },
		});
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		const exit = new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("server did not exit")), 5000);
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
		try {
			const port = await waitForPort(child);
			await checkBridge(`http://127.0.0.1:${port}`);
			const exitCode = await exit;
			expect(exitCode, stderr).toBe(0);
		} finally {
			child.kill("SIGKILL");
		}

		const stats = stderr.split("\n").find((line) => line.startsWith("[perf-http-stats]"));
		expect(stats).toBeDefined();
		const line = stats ?? "";
		expect(field(line, "response_index_lookups")).toBe(
			field(line, "response_index_hits") + field(line, "response_index_misses"),
		);
		expect(field(line, "response_index_hits")).toBeGreaterThan(0);
		expect(field(line, "response_index_misses")).toBeGreaterThan(0);
		expect(field(line, "response_index_peak_entries")).toBeGreaterThanOrEqual(16);
		expect(field(line, "response_index_inserts")).toBe(
			field(line, "response_index_removes"),
		);
		expect(field(line, "response_index_rehashes")).toBeGreaterThanOrEqual(2);
		expect(field(line, "response_index_max_probes")).toBeLessThan(
			field(line, "response_index_peak_entries"),
		);
	});
});
