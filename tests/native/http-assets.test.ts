import { hash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	STRESS_ENV,
	withServer,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-http-assets-"));
const publicDirectory = path.resolve("tests/local/http-assets/public");
const file = (name: string) => readFileSync(path.join(publicDirectory, name));
const etag = (name: string) => `"${hash("sha256", file(name), "hex")}"`;

describe("maligator:http serveAsset", () => {
	let binary: string;
	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/http-assets/main.mjs",
			name: "http-assets",
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	/** Checks a server whose root serves the directory, with index.html as fallback. */
	async function checkDirectory(base: string): Promise<void> {
		const index = await fetch(`${base}/`);
		expect(index.status).toBe(200);
		expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(index.headers.get("cache-control")).toBe("no-cache");
		expect(index.headers.get("etag")).toBe(etag("index.html"));
		expect(await index.text()).toBe(file("index.html").toString());

		expect(await (await fetch(`${base}/nested/`)).text()).toBe(
			file("nested/index.html").toString(),
		);
		const route = await fetch(`${base}/client/route`);
		expect(route.status).toBe(200);
		expect(await route.text()).toBe(file("index.html").toString());

		const notModified = await fetch(`${base}/hello.txt`, {
			headers: { "if-none-match": etag("hello.txt") },
		});
		expect(notModified.status).toBe(304);
		expect(await notModified.text()).toBe("");

		const range = await fetch(`${base}/hello.txt`, { headers: { range: "bytes=0-4" } });
		expect(range.status).toBe(206);
		expect(range.headers.get("content-range")).toBe(
			`bytes 0-4/${file("hello.txt").length}`,
		);
		expect(await range.text()).toBe("hello");
		const unsatisfiable = await fetch(`${base}/hello.txt`, {
			headers: { range: "bytes=999-" },
		});
		expect(unsatisfiable.status).toBe(416);
		expect(unsatisfiable.headers.get("content-range")).toBe(
			`bytes */${file("hello.txt").length}`,
		);

		const head = await fetch(`${base}/hello.txt`, { method: "HEAD" });
		expect(head.headers.get("content-length")).toBe(String(file("hello.txt").length));
		expect(await head.text()).toBe("");

		const post = await fetch(`${base}/hello.txt`, { method: "POST", body: "x" });
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET, HEAD");
	}

	/** Checks the compressed copies of a served text file at `url`. */
	async function checkEncodings(url: string): Promise<void> {
		const original = file("assets/big.js").toString();
		for (const encoding of ["br", "gzip"]) {
			const response = await fetch(url, { headers: { "accept-encoding": encoding } });
			expect(response.headers.get("content-encoding")).toBe(encoding);
			expect(response.headers.get("vary")).toBe("accept-encoding");
			expect(response.headers.get("etag")).toBe(
				`${etag("assets/big.js").slice(0, -1)}-${encoding}"`,
			);
			expect(await response.text()).toBe(original);
		}
		const identity = await fetch(url, { headers: { "accept-encoding": "identity" } });
		expect(identity.headers.get("content-encoding")).toBeNull();
		expect(identity.headers.get("etag")).toBe(etag("assets/big.js"));
		expect(await identity.text()).toBe(original);
		const range = await fetch(url, {
			headers: { "accept-encoding": "br", range: "bytes=0-5" },
		});
		expect(range.status).toBe(206);
		expect(range.headers.get("content-encoding")).toBeNull();
		expect(await range.text()).toBe(original.slice(0, 6));
	}

	async function checkServers(env: NodeJS.ProcessEnv): Promise<void> {
		await withServer(binary, env, async (routed) => {
			const fast = `http://127.0.0.1:${await (await fetch(`${routed}/fast-port`)).text()}`;
			await checkDirectory(fast);
			const hashed = await fetch(`${fast}/assets/app-1234.js`);
			expect(hashed.headers.get("cache-control")).toBe(
				"public, max-age=31536000, immutable",
			);
			expect(hashed.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
			await checkEncodings(`${fast}/assets/big.js`);
			await checkEncodings(`${routed}/static/assets/big.js`);

			expect(await (await fetch(`${routed}/api/ping`)).json()).toEqual({ pong: true });
			expect(await (await fetch(`${routed}/static/hello.txt`)).text()).toBe(
				file("hello.txt").toString(),
			);
			expect(await (await fetch(`${routed}/static/`)).text()).toBe(
				file("index.html").toString(),
			);
			expect((await fetch(`${routed}/elsewhere`)).status).toBe(404);
			const failure = await fetch(`${routed}/throw`);
			expect(failure.status).toBe(500);
			expect(await failure.text()).toBe("Internal Server Error\n");

			expect(await (await fetch(`${routed}/close-fast`)).text()).toBe("closed");
			await expect(fetch(`${fast}/`)).rejects.toThrow();
		});
	}

	it("serves embedded files natively and from a JavaScript handler", async () => {
		await checkServers({});
	});

	it("keeps handles and routes alive under GC stress", async () => {
		await checkServers(STRESS_ENV);
	});
});
