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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-express-http-server-"));

describe("Express 5 HTTP server", () => {
	let binary: string;

	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/express-http-server.cjs",
			name: "express-http-server",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	});

	it("serves routing, middleware, request bodies, and errors", async () => {
		for (const env of [{}, STRESS_ENV]) {
			await withServer(binary, env, async (base) => {
				const user = await fetch(`${base}/users/a%20b?search=teeth&tag=one&tag=two`);
				expect(user.status).toBe(200);
				expect(await user.json()).toEqual({
					id: "a b",
					query: { search: "teeth", tag: ["one", "two"] },
				});

				const middleware = await fetch(`${base}/middleware`);
				expect(await middleware.json()).toEqual({
					order: ["application", "route", "async", "handler"],
				});

				const json = await fetch(`${base}/json`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ teeth: 42 }),
				});
				expect(json.status).toBe(201);
				expect(await json.json()).toEqual({ body: { teeth: 42 } });

				const form = await fetch(`${base}/form`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: "name=Maligator&role=runtime",
				});
				expect(form.status).toBe(200);
				expect(await form.json()).toEqual({
					body: { name: "Maligator", role: "runtime" },
				});

				const redirect = await fetch(`${base}/cookie`, { redirect: "manual" });
				expect(redirect.status).toBe(302);
				expect(redirect.headers.get("location")).toBe("/redirect-target");
				expect(redirect.headers.getSetCookie()).toEqual([
					"wave=zero; Path=/; HttpOnly; SameSite=Lax",
				]);

				const redirected = await fetch(`${base}/redirect-target`);
				expect(redirected.status).toBe(200);
				expect(await redirected.text()).toBe("redirected");

				const missing = await fetch(`${base}/missing`);
				expect(missing.status).toBe(404);
				expect(await missing.json()).toEqual({ error: "Not found: GET /missing" });

				const rejected = await fetch(`${base}/async-error`);
				expect(rejected.status).toBe(500);
				expect(await rejected.json()).toEqual({
					error: "wave-0 async rejection",
				});
			});
		}
	});
});
