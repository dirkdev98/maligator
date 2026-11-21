import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

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

		const result = spawnSync(
			process.execPath,
			[
				path.join(repositoryRoot, "src/index.ts"),
				"run",
				"--config",
				path.join(project, "maligator.build.ts"),
			],
			{ cwd: project, env: process.env, encoding: "utf-8", timeout: 240_000 },
		);

		expect(result.status, result.stderr || result.stdout).toBe(0);
		const output = result.stdout.trim().split("\n").at(-1)!;
		expect(JSON.parse(output)).toEqual({
			page: "GET /page?x=1 ",
			header: "watch",
			missing: 404,
			posted: "POST /echo hello",
		});
	}, 300_000);
});
