import { mkdtempSync } from "node:fs";
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
			skipRuntimeBuild: true,
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
});
