import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHttpSnapshot } from "../scripts/bench-http-ordinary.ts";

const root = path.resolve(import.meta.dirname, "..");
const ohaAvailable = spawnSync("oha", ["--version"], { stdio: "ignore" }).status === 0;
const directories: Array<string> = [];

function makeServer(): { binary: string; directory: string } {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-http-ordinary-"));
	directories.push(directory);
	const binary = path.join(directory, "server.cjs");
	writeFileSync(
		binary,
		`#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const port = Number(process.env.PORT || 3111);
fs.writeFileSync(process.env.TEST_ENV_LOG, JSON.stringify({ gc: process.env.MAL_GC_STATS, perf: process.env.MAL_PERF_STATS }));
if (port === 3113) require(${JSON.stringify(path.join(root, "bench/http/express-server.cjs"))});
else http.createServer((_request, response) => {
  response.writeHead(process.env.TEST_MODE === "wrong-status" ? 503 : 200, { "Content-Type": "text/plain" });
  response.end(process.env.TEST_MODE === "wrong-body" ? "wrong" : "Hello, World!");
}).listen(port, "127.0.0.1", () => console.log("PORT " + port));
`,
	);
	chmodSync(binary, 0o755);
	return { binary, directory };
}

afterEach(() => {
	delete process.env.TEST_MODE;
	delete process.env.TEST_ENV_LOG;
	delete process.env.MAL_GC_STATS;
	delete process.env.MAL_PERF_STATS;
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("ordinary HTTP comparison process", () => {
	it.skipIf(!ohaAvailable)(
		"checks real child responses with GC instrumentation absent",
		async () => {
			const { binary, directory } = makeServer();
			process.env.TEST_ENV_LOG = path.join(directory, "environment.json");
			process.env.MAL_GC_STATS = "1";
			process.env.MAL_PERF_STATS = "1";
			const result = (await runHttpSnapshot(
				{ bare: binary, express: binary },
				root,
				path.join(directory, "evidence"),
				3,
				performance.now() + 90000,
			)) as {
				http: {
					instrumentation: string;
					oracleDigest: string;
					bare: {
						malCompletedRequests: number;
						malCompletedRps: number;
						malCpuPerCompletedRequestMs?: number;
					};
				};
			};
			expect(result.http.instrumentation).toBe("none");
			expect(result.http.oracleDigest).toMatch(/^[a-f0-9]{64}$/);
			expect(result.http.bare.malCompletedRequests).toBeGreaterThan(0);
			expect(result.http.bare.malCompletedRps).toBeGreaterThan(0);
			if (process.platform === "linux") {
				expect(Number.isFinite(result.http.bare.malCpuPerCompletedRequestMs)).toBe(true);
			}
			expect(JSON.parse(readFileSync(process.env.TEST_ENV_LOG, "utf8"))).toEqual({});
		},
		100_000,
	);

	it.skipIf(!ohaAvailable)(
		"rejects a successful status with the wrong body and stops the child",
		async () => {
			const { binary, directory } = makeServer();
			process.env.TEST_ENV_LOG = path.join(directory, "environment.json");
			process.env.TEST_MODE = "wrong-body";
			await expect(
				runHttpSnapshot(
					{ bare: binary, express: binary },
					root,
					path.join(directory, "evidence"),
					1,
					performance.now() + 30000,
				),
			).rejects.toThrow(/response mismatch/);
			await expect(
				fetch("http://127.0.0.1:3111/", { signal: AbortSignal.timeout(500) }),
			).rejects.toThrow();
			await expect(
				fetch("http://127.0.0.1:3112/", { signal: AbortSignal.timeout(500) }),
			).rejects.toThrow();
		},
		45_000,
	);

	it.skipIf(!ohaAvailable)(
		"rejects a child that cannot own its port",
		async () => {
			const { binary, directory } = makeServer();
			process.env.TEST_ENV_LOG = path.join(directory, "environment.json");
			const foreign = createServer();
			await new Promise<void>((resolve) => {
				foreign.listen(3111, "127.0.0.1", resolve);
			});
			try {
				await expect(
					runHttpSnapshot(
						{ bare: binary, express: binary },
						root,
						path.join(directory, "evidence"),
						1,
						performance.now() + 30000,
					),
				).rejects.toThrow(/failed before startup/);
			} finally {
				await new Promise<void>((resolve) => {
					foreign.close(() => resolve());
				});
			}
		},
		45_000,
	);
});
