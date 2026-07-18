import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	STRESS_ENV,
	withServer,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-http-request-"));

describe("node:http request bridge", () => {
	let binaries: Array<string>;

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
	});

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
});
