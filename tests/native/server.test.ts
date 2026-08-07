import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, SERVER_MAIN, withServer } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-server-"));

// Callback-driven HTTP/1.1 server loop (fixed response), driven by Node's fetch.
describe("HTTP server loop", () => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "servertest",
			mainFile: SERVER_MAIN,
			outDir,
		});
	});

	it("serves GET, POST, and reuses keep-alive connections", async () => {
		await withServer(bin, {}, async (base) => {
			const get = await fetch(`${base}/hello`);
			expect(get.status).toBe(200);
			expect(await get.text()).toContain("GET /hello");

			const post = await fetch(`${base}/api/x`, { method: "POST", body: "payload" });
			expect(post.status).toBe(200);
			expect(await post.text()).toContain("POST /api/x");

			// Keep-alive: several sequential requests (undici reuses the connection).
			for (let i = 0; i < 5; i++) {
				const r = await fetch(`${base}/n/${i}`);
				expect(r.status).toBe(200);
				expect(await r.text()).toContain(`/n/${i}`);
			}
		});
	});

	it("bounds connection count and incomplete request lifetimes", async () => {
		await withServer(bin, { MAL_HTTP_TEST_LIMITS: "1" }, async (base) => {
			const url = new URL(base);
			const open = (): Promise<Socket> =>
				new Promise((resolve, reject) => {
					const socket = connect(Number(url.port), url.hostname);
					socket.once("connect", () => resolve(socket));
					socket.once("error", reject);
				});
			const closed = (socket: Socket): Promise<string> =>
				new Promise((resolve, reject) => {
					const chunks: Array<Buffer> = [];
					if (socket.destroyed) {
						resolve("");
						return;
					}
					const timeout = setTimeout(() => {
						socket.destroy();
						reject(new Error("HTTP limit did not close the socket"));
					}, 2000);
					socket.on("data", (chunk: Buffer) => chunks.push(chunk));
					socket.once("close", () => {
						clearTimeout(timeout);
						resolve(Buffer.concat(chunks).toString("latin1"));
					});
					socket.once("error", () => undefined);
				});

			// One partial header occupies the single connection slot; the next
			// accepted socket is dropped instead of allocating another connection.
			const held = await open();
			held.write("G");
			const refused = await open();
			await closed(refused);
			await closed(held);

			// A complete head with an incomplete body has its own absolute deadline.
			const body = await open();
			body.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\nx");
			await closed(body);

			// After a response, an otherwise reusable idle connection is reaped.
			const idle = await open();
			idle.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
			const response = await closed(idle);
			expect(response).toContain("HTTP/1.1 200");
		});
	});
});
