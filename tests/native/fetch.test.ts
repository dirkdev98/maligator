import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN, STRESS_ENV, withServer } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-fetch-"));

// WinterTC fetch server: Mal.serve + native Request/Response. Two binaries — the
// async handler (proves Promise<Response> under normal auto-GC) and the sync
// handler (rigorously validates server / Request / Response / promise-reaction
// rooting under collect-at-every-safepoint, without tripping the known async-frame
// rooting gap under STRESS).
describe("Mal.serve fetch server", () => {
	let asyncBin: string;
	let syncBin: string;
	beforeAll(() => {
		asyncBin = buildNativeBinary({
			fixture: "tests/local/fetch_server.js",
			name: "fetchtest",
			mainFile: HOST_MAIN,
			outDir,
			skipRuntimeBuild: true,
		});
		syncBin = buildNativeBinary({
			fixture: "tests/local/fetch_server_sync.js",
			name: "fetchtest-sync",
			mainFile: HOST_MAIN,
			outDir,
			skipRuntimeBuild: true,
		});
	});

	// Checks that run against BOTH the sync and async handler binaries.
	async function checkCommon(base: string): Promise<void> {
		const get = await fetch(`${base}/hello`);
		expect(get.status).toBe(200);
		const getText = await get.text();
		expect(getText).toContain("hello GET");
		expect(getText).toContain("/hello");

		const post = await fetch(`${base}/x`, { method: "POST", body: "b" });
		expect(await post.text()).toContain("hello POST");

		const created = await fetch(`${base}/created`);
		expect(created.status).toBe(201);
		expect(await created.text()).toBe("made");

		const json = await fetch(`${base}/json`);
		expect(json.headers.get("content-type")).toBe("application/json");
		expect(await json.text()).toBe('{"ok":true}');

		const echo = await fetch(`${base}/echo`, { headers: { "x-test": "hi" } });
		expect(await echo.text()).toBe("hi");

		const bytes = new Uint8Array(await (await fetch(`${base}/binary`)).arrayBuffer());
		expect(bytes.length).toBe(5);
		expect([bytes[0], bytes[4]]).toEqual([1, 5]);

		const rj = await fetch(`${base}/rjson`);
		expect(rj.headers.get("content-type")).toBe("application/json");
		expect(await rj.json()).toMatchObject({ ok: true, n: 42 });

		// keep-alive: several sequential requests reuse the connection.
		for (let i = 0; i < 5; i++) {
			const r = await fetch(`${base}/n/${i}`);
			expect(r.status).toBe(200);
			expect(await r.text()).toContain(`/n/${i}`);
		}
	}

	it("async handler serves + reads request bodies (compiled)", async () => {
		await withServer(asyncBin, {}, async (base) => {
			await checkCommon(base);

			const asyncRes = await fetch(`${base}/async`);
			expect(asyncRes.status).toBe(200);
			expect(await asyncRes.text()).toBe("async-done");

			const body = await fetch(`${base}/body`, { method: "POST", body: "hello-body" });
			expect(await body.text()).toBe("body=hello-body");

			const sum = await fetch(`${base}/sum`, { method: "POST", body: JSON.stringify({ a: 3, b: 4 }) });
			expect(await sum.text()).toBe("7");

			const abuf = await fetch(`${base}/abuf`, { method: "POST", body: "abcd" });
			expect(await abuf.text()).toBe("len=4");

			const bytesReq = await fetch(`${base}/bytes`, { method: "POST", body: "xy" });
			expect(await bytesReq.text()).toBe("b=120-121-2");

			const rr = await (await fetch(`${base}/respread`)).text();
			expect(rr).toBe("t=hello-resp,ab=10,b0=104,status=201,ok=true,st=Created");

			const rc = await (await fetch(`${base}/reqctor`)).text();
			expect(rc).toBe("m=PUT,u=https://x/y,h=v,b=abc");

			// A ReadableStream body makes undici send Transfer-Encoding: chunked.
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("chunked-data"));
					controller.close();
				},
			});
			// `duplex: "half"` is required by undici for a stream body but isn't in the
			// TS RequestInit type.
			const chunkedInit = { method: "POST", body: stream, duplex: "half" };
			const chunked = await fetch(`${base}/body`, chunkedInit);
			expect(await chunked.text()).toBe("body=chunked-data");
		});
	});

	it("sync handler serves under MAL_GC_STRESS + MAL_GC_VERIFY", async () => {
		await withServer(syncBin, STRESS_ENV, async (base) => {
			await checkCommon(base);
		});
	});
});
