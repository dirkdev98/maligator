import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startDevelopmentDriver } from "../../scripts/development-driver.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const project = mkdtempSync(path.join(os.tmpdir(), "mal-http-watch-proxy-"));
afterAll(() => rmSync(project, { recursive: true, force: true }));

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});
}

describe("serveAsset with a watched declaration", () => {
	it("forwards requests to the watcher's server while it runs", async () => {
		const port = await freePort();
		mkdirSync(path.join(project, "dist"));
		writeFileSync(path.join(project, "package.json"), '{ "type": "module" }\n');
		writeFileSync(
			path.join(project, "upstream.mjs"),
			`import { createServer } from "node:http";
createServer((request, response) => {
	let body = "";
	request.setEncoding("utf8");
	request.on("data", (chunk) => (body += chunk));
	request.on("end", () => {
		if (request.url === "/missing") {
			response.writeHead(404).end();
			return;
		}
		response.writeHead(200, { "content-type": "text/plain", "x-upstream": "watch" });
		response.end(request.method + " " + request.url + " " + body);
	});
}).listen(${port}, "127.0.0.1");
`,
		);
		writeFileSync(
			path.join(project, "main.mjs"),
			`import { embedDirectory } from "maligator:assets";
import { serve, serveAsset } from "maligator:http";

const site = embedDirectory("./dist", {
	watch: {
		command: [${JSON.stringify(process.execPath)}, "upstream.mjs"],
		url: "http://127.0.0.1:${port}/",
	},
	use: { run: "watch" },
});
const server = serve({ hostname: "127.0.0.1", port: 0, fetch: serveAsset(site) });
const page = await fetch(new URL("/page?x=1", server.url));
const missing = await fetch(new URL("/missing", server.url));
const posted = await fetch(new URL("/echo", server.url), { method: "POST", body: "hello" });
console.log(JSON.stringify({
	page: await page.text(),
	header: page.headers.get("x-upstream"),
	missing: missing.status,
	posted: await posted.text(),
}));
await server.close();
`,
		);
		writeFileSync(
			path.join(project, "maligator.build.ts"),
			'export default { entry: "main.mjs" };\n',
		);

		for (const phase of ["cold", "warm"]) {
			const result = spawnSync(
				process.execPath,
				[
					path.join(repositoryRoot, "src/index.ts"),
					"run",
					"--verbose",
					"--config",
					path.join(project, "maligator.build.ts"),
				],
				{ cwd: project, env: process.env, encoding: "utf-8", timeout: 240_000 },
			);

			expect(result.status, result.stderr || result.stdout).toBe(0);
			if (phase === "warm") expect(result.stderr).toContain("Frontend cache: hit");
			const output = result.stdout.trim().split("\n").at(-1)!;
			expect(JSON.parse(output)).toEqual({
				page: "GET /page?x=1 ",
				header: "watch",
				missing: 404,
				posted: "POST /echo hello",
			});
		}
	}, 300_000);

	it("uses the watcher only for the command that starts it when switching a warm cache", async () => {
		const port = await freePort();
		const root = mkdtempSync(path.join(project, "command-switch-"));
		mkdirSync(path.join(root, "dist"));
		writeFileSync(path.join(root, "dist/index.html"), "0");
		writeFileSync(
			path.join(root, "upstream.mjs"),
			`import { createServer } from "node:http";
createServer((_request, response) => response.end("1")).listen(${port}, "127.0.0.1");`,
		);
		writeFileSync(
			path.join(root, "site.mjs"),
			`import { embedDirectory } from "maligator:assets";
export const site = embedDirectory("./dist", {
	watch: { command: [${JSON.stringify(process.execPath)}, "upstream.mjs"], url: "http://127.0.0.1:${port}/" },
});`,
		);
		writeFileSync(
			path.join(root, "main.mjs"),
			`import { ready } from "maligator:application";
import { serve, serveAsset } from "maligator:http";
import { site } from "./site.mjs";
const server = serve({ hostname: "127.0.0.1", port: 0, fetch: serveAsset(site) });
console.log("DX_HTTP_PORT " + new URL(server.url).port);
ready();`,
		);

		for (const [command, revision] of [
			["run", 0],
			["dev", 1],
			["run", 0],
		] as const) {
			const driver = startDevelopmentDriver(
				process.execPath,
				[path.join(repositoryRoot, "src/index.ts"), command, "main.mjs"],
				{
					cwd: root,
					readinessTimeoutMs: 60_000,
				},
			);
			try {
				await driver.waitForRevision(revision);
			} finally {
				await driver.stop();
			}
		}
	}, 240_000);
});
