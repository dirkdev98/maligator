import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	captureChildExit,
	HOST_MAIN,
	STRESS_ENV,
	waitForChildExit,
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
		const matches = [
			...line.matchAll(new RegExp(`(?:^|\\s)${name}=([0-9]+)(?=\\s|$)`, "g")),
		];
		if (matches.length !== 1) {
			throw new Error(`expected exactly one ${name} field in: ${line}`);
		}
		const value = Number(matches[0]![1]);
		if (!Number.isSafeInteger(value)) {
			throw new Error(`invalid ${name} field in: ${line}`);
		}
		return value;
	}

	async function checkBridge(base: string): Promise<void> {
		const port = Number(new URL(base).port);
		const manyRequestHeaders: Record<string, string> = {};
		for (let i = 0; i < 40; i++) {
			const suffix = String(i).padStart(2, "0");
			manyRequestHeaders[`x-request-${suffix}`] =
				`value-${suffix}-abcdefghijklmnopqrstuvwxyz0123456789`;
		}
		const manyHeaders = await fetch(`${base}/many-headers`, {
			headers: manyRequestHeaders,
		});
		expect(manyHeaders.status).toBe(200);
		for (let i = 0; i < 24; i++) {
			expect(manyHeaders.headers.get(`x-response-${i}`)).toBe(`reply-${i}`);
		}
		expect(await manyHeaders.text()).toBe("many");

		const headerSnapshot = await new Promise<string>((resolve, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port }, () => {
				socket.write(
					"GET /header-snapshot HTTP/1.1\r\n" +
						"Host: 127.0.0.1\r\n" +
						"X-Mixed: first\r\n" +
						"x-MIXED: second\r\n" +
						"Cookie: a=1\r\n" +
						"cookie: b=2\r\n" +
						"Set-Cookie: one=1\r\n" +
						"set-cookie: two=2\r\n" +
						"Authorization: first\r\n" +
						"authorization: second\r\n" +
						"X-Order: third\r\n" +
						"Connection: close\r\n\r\n",
				);
			});
			let response = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => (response += chunk));
			socket.on("end", () => resolve(response));
			socket.once("error", reject);
		});
		expect(headerSnapshot).toContain("HTTP/1.1 200 OK");
		expect(headerSnapshot).toContain("\r\n\r\nok");

		const reusedConnection = await new Promise<string>((resolve, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port }, () => {
				socket.write(
					"GET /header-reuse/first HTTP/1.1\r\n" +
						"Host: 127.0.0.1\r\n" +
						"X-ReUsEd: first-value\r\n\r\n" +
						"GET /header-reuse/second HTTP/1.1\r\n" +
						"Host: 127.0.0.1\r\n" +
						"x-rEuSeD: second-value\r\n" +
						"Connection: close\r\n\r\n",
				);
			});
			let response = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => (response += chunk));
			socket.on("end", () => resolve(response));
			socket.once("error", reject);
		});
		expect(reusedConnection.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2);
		expect(reusedConnection).toContain("reuse:first");
		expect(reusedConnection).toContain("reuse:second");
		expect(reusedConnection.indexOf("reuse:first")).toBeLessThan(
			reusedConnection.indexOf("reuse:second"),
		);

		const malformedHeader = await new Promise<string>((resolve, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port }, () => {
				socket.end(
					"GET /must-not-dispatch HTTP/1.1\r\n" +
						"Host: 127.0.0.1\r\nBad Header: rejected\r\n\r\n",
				);
			});
			let response = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => (response += chunk));
			socket.on("end", () => resolve(response));
			socket.once("error", reject);
		});
		expect(malformedHeader).toContain("HTTP/1.1 400 Bad Request");

		const metadata = await fetch(`${base}/metadata`, {
			headers: { "x-test": "request-header" },
		});
		expect(metadata.status).toBe(201);
		expect(metadata.headers.get("x-reply")).toBe("response-header");
		expect(await metadata.text()).toBe("ab");

		const socketShape = await fetch(`${base}/socket-shape`);
		const socketShapeBody = await socketShape.text();
		expect(socketShape.status, socketShapeBody).toBe(200);
		expect(socketShapeBody).toBe("ok");

		const responseShape = await fetch(`${base}/response-shape`);
		const responseShapeBody = await responseShape.text();
		expect(responseShape.status, responseShapeBody).toBe(200);
		expect(responseShapeBody).toBe("ok");

		const prepareUnusual = await fetch(`${base}/prepare-unusual-response`);
		expect(await prepareUnusual.text()).toBe("prepared");
		const unusualShape = await fetch(`${base}/unusual-response-shape`);
		expect(unusualShape.status).toBe(200);
		expect(await unusualShape.text()).toBe("ok");

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
		expect(head.headers.get("content-length")).toBeNull();
		expect(await head.text()).toBe("");

		const noBody = await fetch(`${base}/no-body`);
		expect(noBody.status).toBe(204);
		expect(noBody.headers.get("content-length")).toBeNull();
		expect(await noBody.text()).toBe("");

		const reentrant = await fetch(`${base}/reentrant`);
		expect(reentrant.status).toBe(200);
		expect(await reentrant.text()).toBe("nested");

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

	it("streams responses with bounded backpressure and wire-correct framing", async () => {
		const runs = [
			{ binary: binaries[0]!, env: {} },
			{ binary: binaries[1]!, env: {} },
			{ binary: binaries[0]!, env: STRESS_ENV },
		];
		for (const { binary, env } of runs) {
			const child = spawn(binary, [], {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...env },
			});
			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
			const exit = captureChildExit(child);
			try {
				const port = await waitForPort(child);
				const base = `http://127.0.0.1:${port}`;
				const streamed = await fetch(`${base}/stream-backpressure`);
				const body = Buffer.from(await streamed.arrayBuffer());
				expect(body.length).toBe(4 * 64 * 1024 + 4);
				expect(body.subarray(0, -4).every((byte) => byte === 120)).toBe(true);
				expect(body.subarray(-4).toString()).toBe("tail");

				const events = await fetch(`${base}/stream-backpressure-events`);
				expect(await events.text()).toBe(
					"return:true,return:true,return:true,return:false," +
						"write:0,write:1,drain,write:2,write:3,finish",
				);
				const endedBeforeDrain = await fetch(`${base}/end-before-drain`);
				expect((await endedBeforeDrain.arrayBuffer()).byteLength).toBe(4 * 64 * 1024 + 4);
				const endEvents = await fetch(`${base}/end-before-drain-events`);
				expect(await endEvents.text()).toBe("finish,end");

				const wire = await new Promise<string>((resolve, reject) => {
					const socket = createConnection({ host: "127.0.0.1", port }, () => {
						socket.write(
							"GET /wire-stream HTTP/1.1\r\n" +
								"Host: 127.0.0.1\r\nConnection: close\r\n\r\n",
						);
					});
					let response = "";
					socket.setEncoding("utf8");
					socket.on("data", (chunk: string) => (response += chunk));
					socket.on("end", () => resolve(response));
					socket.once("error", reject);
				});
				expect(wire).toContain("Transfer-Encoding: chunked\r\n");
				expect(wire).not.toContain("Content-Length:");
				expect(wire.slice(wire.indexOf("\r\n\r\n") + 4)).toBe(
					"2\r\nab\r\n3\r\ncde\r\n1\r\nf\r\n0\r\n\r\n",
				);

				const halfClosed = await new Promise<string>((resolve, reject) => {
					const socket = createConnection({ host: "127.0.0.1", port }, () => {
						socket.end("GET /async HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
					});
					let response = "";
					socket.setEncoding("utf8");
					socket.on("data", (chunk: string) => (response += chunk));
					socket.on("end", () => resolve(response));
					socket.once("error", reject);
				});
				expect(halfClosed).toContain("HTTP/1.1 200 OK");
				expect(halfClosed).toContain("\r\n\r\nyes");

				const fixed = await fetch(`${base}/fixed-stream`);
				expect(fixed.headers.get("content-length")).toBe("6");
				expect(fixed.headers.get("transfer-encoding")).toBeNull();
				expect(await fixed.text()).toBe("abcdef");

				const head = await fetch(`${base}/head-explicit`, { method: "HEAD" });
				expect(head.headers.get("content-length")).toBe("2");
				expect(await head.text()).toBe("");

				const reentrant = await fetch(`${base}/reentrant-commit`);
				expect(reentrant.status).toBe(500);
				expect(await reentrant.text()).toBe("request handler error");
				const removeAfterWrite = await fetch(`${base}/remove-after-write`);
				expect(await removeAfterWrite.text()).toBe("aServerResponse is not writable");

				for (const length of ["1e2", "9223372036854775808"]) {
					const invalid = await fetch(`${base}/invalid-content-length/${length}`);
					expect(invalid.status).toBe(500);
					expect(await invalid.text()).toBe("Invalid content-length header");
				}
				for (const route of ["short-content-length", "long-content-length"]) {
					await expect(
						fetch(`${base}/${route}`).then((response) => response.text()),
					).rejects.toThrow();
				}

				await new Promise<void>((resolve, reject) => {
					const socket = createConnection({ host: "127.0.0.1", port }, () => {
						socket.write("GET /failed-write HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
					});
					socket.once("data", () => {
						socket.destroy();
						resolve();
					});
					socket.once("error", reject);
				});
				let failedWriteEvents = "";
				for (let attempt = 0; attempt < 100; attempt++) {
					const eventsResponse = await fetch(`${base}/failed-write-events`);
					failedWriteEvents = await eventsResponse.text();
					if (failedWriteEvents.endsWith(",close")) break;
					await new Promise<void>((resolve) => {
						setTimeout(resolve, 10);
					});
				}
				const failedEvents = failedWriteEvents.split(",");
				expect(failedEvents.at(-2)).toBe("end:true");
				expect(failedEvents.at(-1)).toBe("close");
				const writeEvents = failedEvents.slice(0, -2);
				expect(writeEvents).toHaveLength(16);
				expect(writeEvents.map((event) => Number(event.split(":")[1]))).toEqual(
					Array.from({ length: 16 }, (_, index) => index),
				);
				expect(writeEvents.some((event) => event.endsWith(":true"))).toBe(true);

				await expect(
					fetch(`${base}/throw-after-write`).then((response) => response.text()),
				).rejects.toThrow();
				const afterFailure = await fetch(`${base}/metadata`, {
					headers: { "x-test": "request-header" },
				});
				expect(afterFailure.status).toBe(201);
				expect(await afterFailure.text()).toBe("ab");

				await new Promise<void>((resolve, reject) => {
					const socket = createConnection({ host: "127.0.0.1", port }, () => {
						socket.write("GET /idle-stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
					});
					socket.once("data", () => {
						socket.destroy();
						resolve();
					});
					socket.once("error", reject);
				});
				const close = await fetch(`${base}/close`);
				expect(await close.text()).toBe("closed");
				expect(await waitForChildExit(exit, 5000), stderr).toBe(0);
			} finally {
				child.kill("SIGKILL");
			}
		}
	});

	it("streams request bodies under read credit and preserves pipeline order", async () => {
		const runs = [
			{ binary: binaries[0]!, env: {} },
			{ binary: binaries[1]!, env: {} },
			{ binary: binaries[0]!, env: STRESS_ENV },
		];
		for (const { binary, env } of runs) {
			const child = spawn(binary, [], {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...env },
			});
			let stderr = "";
			child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
			const exit = captureChildExit(child);
			try {
				const port = await waitForPort(child);
				const base = `http://127.0.0.1:${port}`;
				const payload = Buffer.alloc(512 * 1024 + 123, 97);
				const upload = await fetch(`${base}/stream-upload`, {
					method: "POST",
					body: payload,
				});
				expect(await upload.text()).toBe(`${payload.length}:97:97`);
				expect(upload.headers.get("x-initial-complete")).toBe("false");
				expect(upload.headers.get("x-final-complete")).toBe("true");
				expect(Number(upload.headers.get("x-max-chunk"))).toBeLessThanOrEqual(64 * 1024);
				expect(Number(upload.headers.get("x-chunk-count"))).toBeGreaterThan(8);
				expect(upload.headers.get("x-data-while-paused")).toBe("false");

				const chunked = await new Promise<string>((resolve, reject) => {
					const socket = createConnection({ host: "127.0.0.1", port }, () => {
						const parts = [
							"POST /chunked-upload HTTP/1.1\r\nHost: 127.0.0.1\r\n",
							"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r",
							"\nabc\r\n4;ext=yes\r\n",
							"defg\r\n0\r\nTrailer: ignored\r\n\r\n",
						];
						let index = 0;
						const writePart = () => {
							socket.write(parts[index++]!);
							if (index < parts.length) setTimeout(writePart, 1);
						};
						writePart();
					});
					let response = "";
					socket.setEncoding("utf8");
					socket.on("data", (chunk: string) => (response += chunk));
					socket.on("end", () => resolve(response));
					socket.once("error", reject);
				});
				expect(chunked).toContain("HTTP/1.1 200 OK");
				expect(chunked).toContain("\r\n\r\nabcdefg");

				await new Promise<void>((resolve) => {
					const socket = createConnection({ host: "127.0.0.1", port }, () => {
						socket.write(
							"POST /malformed-upload HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
								"Transfer-Encoding: chunked\r\n\r\nZ\r\ninvalid\r\n",
						);
						socket.resume();
					});
					socket.once("close", () => resolve());
					socket.once("error", () => resolve());
				});
				let malformed = "";
				for (let attempt = 0; attempt < 100; attempt++) {
					malformed = await fetch(`${base}/malformed-upload-status`).then((response) =>
						response.text(),
					);
					if (malformed === "true:false:true") break;
					await new Promise<void>((resolve) => {
						setTimeout(resolve, 10);
					});
				}
				expect(malformed).toBe("true:false:true");

				const early = await new Promise<string>((resolve, reject) => {
					const total = 32 * 1024;
					const socket = createConnection({ host: "127.0.0.1", port }, () => {
						socket.write(
							`POST /early-upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${total}\r\n\r\nhello`,
						);
					});
					let response = "";
					let sentRemainder = false;
					socket.setEncoding("utf8");
					socket.on("data", (chunk: string) => {
						response += chunk;
						if (!sentRemainder && response.includes("\r\n\r\nearly")) {
							sentRemainder = true;
							socket.write(Buffer.alloc(total - 5, 122));
							socket.write(
								"GET /early-upload-status HTTP/1.1\r\n" +
									"Host: 127.0.0.1\r\nConnection: close\r\n\r\n",
							);
						}
					});
					socket.on("end", () => resolve(response));
					socket.once("error", reject);
				});
				expect(early.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2);
				expect(early.indexOf("early")).toBeLessThan(early.lastIndexOf("32768:true"));
				expect(early).toContain("32768:true");

				const unread = await new Promise<string>((resolve, reject) => {
					const total = 8 * 1024;
					const socket = createConnection({ host: "127.0.0.1", port }, () => {
						socket.write(
							`POST /early-unread HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${total}\r\n\r\nx`,
						);
					});
					let response = "";
					let sentRemainder = false;
					socket.setEncoding("utf8");
					socket.on("data", (chunk: string) => {
						response += chunk;
						if (!sentRemainder && response.includes("\r\n\r\nunread")) {
							sentRemainder = true;
							socket.write(Buffer.alloc(total - 1, 117));
							socket.write(
								"GET /early-unread-status HTTP/1.1\r\n" +
									"Host: 127.0.0.1\r\nConnection: close\r\n\r\n",
							);
						}
					});
					socket.on("end", () => resolve(response));
					socket.once("error", reject);
				});
				expect(unread.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2);
				expect(unread).toContain("\r\n\r\ntrue");

				await new Promise<void>((resolve, reject) => {
					const socket = createConnection({ host: "127.0.0.1", port }, () => {
						socket.write(
							"POST /aborted-upload HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
								"Content-Length: 100\r\n\r\nhello",
						);
						setTimeout(() => {
							socket.destroy();
							resolve();
						}, 20);
					});
					socket.once("error", reject);
				});
				let aborted = "";
				for (let attempt = 0; attempt < 100; attempt++) {
					aborted = await fetch(`${base}/aborted-upload-status`).then((response) =>
						response.text(),
					);
					if (aborted.endsWith(":true")) break;
					await new Promise<void>((resolve) => {
						setTimeout(resolve, 10);
					});
				}
				expect(aborted).toBe("5:true:false:true");

				await new Promise<void>((resolve, reject) => {
					const socket = createConnection({ host: "127.0.0.1", port }, () => {
						socket.write(
							"POST /destroyed-upload HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
								"Content-Length: 100\r\n\r\n01234567890123456789",
						);
					});
					socket.once("close", () => resolve());
					socket.once("error", reject);
				});
				let destroyed = "";
				for (let attempt = 0; attempt < 100; attempt++) {
					destroyed = await fetch(`${base}/destroyed-upload-status`).then((response) =>
						response.text(),
					);
					if (destroyed === "true:true:true:1") break;
					await new Promise<void>((resolve) => {
						setTimeout(resolve, 10);
					});
				}
				expect(destroyed).toBe("true:true:true:1");

				const failedHandler = await fetch(`${base}/throw-during-upload`, {
					method: "POST",
					body: Buffer.alloc(128 * 1024, 120),
				});
				expect(failedHandler.status).toBe(500);
				expect(await failedHandler.text()).toBe("request handler error");
				const afterFailedHandler = await fetch(`${base}/metadata`, {
					headers: { "x-test": "request-header" },
				});
				expect(afterFailedHandler.status).toBe(201);
				expect(await afterFailedHandler.text()).toBe("ab");

				const closingPayload = Buffer.alloc(64 * 1024 + 7, 99);
				const close = await fetch(`${base}/close-during-upload`, {
					method: "POST",
					body: closingPayload,
				});
				expect(await close.text()).toBe(String(closingPayload.length));
				expect(await waitForChildExit(exit, 5000), stderr).toBe(0);
			} finally {
				child.kill("SIGKILL");
			}
		}
	}, 180_000);

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
		const exit = captureChildExit(child);
		try {
			const port = await waitForPort(child);
			await checkBridge(`http://127.0.0.1:${port}`);
			const exitCode = await waitForChildExit(exit, 5000);
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
		expect(field(line, "response_header_name_coercions")).toBe(803);
		expect(field(line, "response_header_name_materializations")).toBe(225);
		expect(field(line, "response_header_insertions")).toBe(225);
		expect(field(line, "response_header_replacements")).toBe(64);
		expect(field(line, "response_header_allocation_free_lookups")).toBe(577);
		expect(field(line, "response_header_spills")).toBeGreaterThanOrEqual(2);
		expect(field(line, "response_header_max_count")).toBeGreaterThanOrEqual(24);
		expect(field(line, "codec_field_spills")).toBeGreaterThan(0);
		expect(field(line, "codec_arena_spills")).toBeGreaterThan(0);
		expect(field(line, "codec_max_fields")).toBeGreaterThan(40);
		expect(field(line, "codec_max_head_bytes")).toBeGreaterThan(1024);
		expect(field(line, "request_state_scans")).toBe(0);
		expect(field(line, "close_request_state_scans")).toBe(0);
		expect(field(line, "request_remove_scans")).toBe(0);
		expect(field(line, "dispatch_enqueues")).toBe(field(line, "dispatch_dequeues"));
		expect(field(line, "completion_enqueues")).toBe(field(line, "completion_dequeues"));
		expect(field(line, "request_inserts")).toBe(field(line, "request_removes"));
		expect(field(line, "request_state_allocations")).toBe(86);
		expect(field(line, "request_state_direct_frees")).toBe(86);
		expect(field(line, "request_body_allocations")).toBe(1);
		expect(field(line, "request_body_transfers")).toBe(1);
		expect(field(line, "request_body_direct_frees")).toBe(0);
		expect(field(line, "request_packed_headers")).toBeGreaterThan(80);
		expect(field(line, "request_copy_operations")).toBe(
			field(line, "request_state_allocations") * 2 +
				field(line, "request_packed_headers") * 2,
		);
		expect(field(line, "request_copy_bytes")).toBeGreaterThan(
			field(line, "request_copy_operations"),
		);
		expect(field(line, "bulk_shaped_objects")).toBe(86);
		expect(field(line, "bulk_shaped_slots")).toBe(1118);
		expect(field(line, "property_definitions_avoided")).toBe(1118);
		expect(field(line, "shape_transitions_avoided")).toBe(1118);
		expect(field(line, "incoming_message_shape_append_batches")).toBe(85);
		expect(field(line, "incoming_message_shape_append_slots")).toBe(1190);
		expect(field(line, "incoming_message_shape_append_fallbacks")).toBe(1);
		expect(field(line, "incoming_message_slot_growths_avoided")).toBe(1105);
		expect(field(line, "response_constructor_shape_append_batches")).toBe(86);
		expect(field(line, "response_constructor_shape_append_slots")).toBe(516);
		expect(field(line, "response_constructor_shape_append_fallbacks")).toBe(1);
		expect(field(line, "response_constructor_slot_growths_avoided")).toBe(430);
		expect(field(line, "response_shape_append_batches")).toBe(85);
		expect(field(line, "response_shape_append_slots")).toBe(170);
		expect(field(line, "response_shape_append_fallbacks")).toBe(1);
		expect(field(line, "response_slot_growths_avoided")).toBe(85);
	});
});
