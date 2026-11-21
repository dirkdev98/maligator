import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHttpGcDiagnostic, runHttpSnapshot } from "../scripts/bench-http-ordinary.ts";

const root = path.resolve(import.meta.dirname, "..");
const ohaAvailable = spawnSync("oha", ["--version"], { stdio: "ignore" }).status === 0;
const directories: Array<string> = [];

function recordPort(file: string): string {
	return `const fs = require("node:fs");
const http = require("node:http");
const createServer = http.createServer;
http.createServer = (...args) => {
  const server = createServer(...args);
  server.once("listening", () => fs.writeFileSync(${JSON.stringify(file)}, String(server.address().port)));
  return server;
};`;
}

function makeServers(): {
	binaries: { bare: string; express: string };
	directory: string;
	reference: string;
} {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-http-ordinary-"));
	directories.push(directory);
	const reference = path.join(directory, "reference");
	const fixtures = path.join(reference, "bench/http");
	mkdirSync(fixtures, { recursive: true });
	const binaries = { bare: "", express: "" };
	for (const kind of ["bare", "express"] as const) {
		const fixture = kind === "bare" ? "server_node.js" : "express-server.cjs";
		writeFileSync(
			path.join(fixtures, fixture),
			`${recordPort(path.join(directory, `${kind}-node.port`))}
require(${JSON.stringify(path.join(root, "bench/http", fixture))});\n`,
		);
		const binary = path.join(directory, `${kind}.cjs`);
		binaries[kind] = binary;
		writeFileSync(
			binary,
			`#!/usr/bin/env node
${recordPort(path.join(directory, `${kind}-mal.port`))}
if (process.env.TEST_MODE === "exit-before-ready") {
  process.stdout.write("PORT 42");
  process.exitCode = 9;
  return;
}
fs.writeFileSync(process.env.TEST_ENV_LOG, JSON.stringify({ gc: process.env.MAL_GC_STATS, control: process.env.MAL_GC_CONTROL, perf: process.env.MAL_PERF_STATS }));
let statsCount = 0;
let requestCount = 0;
if (process.env.TEST_DIAGNOSTIC_MODE) {
  process.on("SIGUSR1", () => {
    if (process.env.TEST_DIAGNOSTIC_MODE === "exit") process.exit(9);
    if (process.env.TEST_DIAGNOSTIC_MODE === "no-ack") return;
    statsCount++;
    const line = "[gc-stats] collections=" + statsCount + " allocated_bytes=" + (requestCount * 16) + " total_ms=" + statsCount + " max_pause_ms=" + (3 - statsCount) + "\\n";
    process.stderr.write(line.slice(0, 24));
    setTimeout(() => process.stderr.write(line.slice(24)), 2);
  });
  const originalCreateServer = http.createServer;
  http.createServer = (...args) => {
    const server = originalCreateServer(...args);
    server.on("request", () => {
      requestCount++;
    });
    return server;
  };
}
${
	kind === "express"
		? `require(${JSON.stringify(path.join(root, "bench/http", fixture))});`
		: `const server = http.createServer((_request, response) => {
  response.writeHead(process.env.TEST_MODE === "wrong-status" ? 503 : 200, { "Content-Type": "text/plain" });
  response.end(process.env.TEST_MODE === "wrong-body" ? "wrong" : "Hello, World!");
});
server.listen(0, "127.0.0.1", () => {
  const line = "PORT " + server.address().port + "\\n";
  process.stdout.write(line.slice(0, 7));
  setTimeout(() => process.stdout.write(line.slice(7)), 20);
});`
}
`,
		);
		chmodSync(binary, 0o755);
	}
	return { binaries, directory, reference };
}

async function expectStopped(directory: string, listener: string): Promise<void> {
	const port = readFileSync(path.join(directory, `${listener}.port`), "utf8");
	await expect(
		fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }),
	).rejects.toMatchObject({ cause: { code: "ECONNREFUSED" } });
}

afterEach(() => {
	delete process.env.TEST_MODE;
	delete process.env.TEST_ENV_LOG;
	delete process.env.TEST_DIAGNOSTIC_MODE;
	delete process.env.MAL_GC_STATS;
	delete process.env.MAL_PERF_STATS;
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("ordinary HTTP comparison process", () => {
	it.skipIf(!ohaAvailable)(
		"checks real child responses with GC instrumentation absent",
		async () => {
			const { binaries, directory, reference } = makeServers();
			process.env.TEST_ENV_LOG = path.join(directory, "environment.json");
			process.env.MAL_GC_STATS = "1";
			process.env.MAL_PERF_STATS = "1";
			const result = (await runHttpSnapshot(
				binaries,
				reference,
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
		"records split, acknowledged GC snapshots only in a fresh diagnostic child",
		async () => {
			const { binaries, directory, reference } = makeServers();
			process.env.TEST_ENV_LOG = path.join(directory, "environment.json");
			process.env.TEST_DIAGNOSTIC_MODE = "ack";
			const result = (await runHttpGcDiagnostic(
				binaries.express,
				reference,
				path.join(directory, "diagnostic"),
				1,
				performance.now() + 30000,
			)) as {
				status: string;
				gc: {
					delta: Record<string, number>;
					before: { raw: string };
					after: { raw: string };
				};
			};
			expect(result.status).toBe("complete");
			expect(result.gc.delta.collections).toBe(1);
			expect(result.gc.delta.allocated_bytes).toBeGreaterThan(0);
			expect(result.gc.delta.max_pause_ms).toBeUndefined();
			expect(result.gc.before.raw).toMatch(/^\[gc-stats\].*\n?$/);
			expect(result.gc.after.raw).toMatch(/^\[gc-stats\].*\n?$/);
			expect(JSON.parse(readFileSync(process.env.TEST_ENV_LOG, "utf8"))).toEqual({
				gc: "1",
				control: "1",
			});
		},
		40_000,
	);

	it.skipIf(!ohaAvailable)(
		"fails a missing GC snapshot acknowledgment and stops the diagnostic child",
		async () => {
			const { binaries, directory, reference } = makeServers();
			process.env.TEST_ENV_LOG = path.join(directory, "environment.json");
			process.env.TEST_DIAGNOSTIC_MODE = "no-ack";
			await expect(
				runHttpGcDiagnostic(
					binaries.express,
					reference,
					path.join(directory, "diagnostic"),
					1,
					performance.now() + 15000,
				),
			).rejects.toThrow(/not acknowledged/);
			await expectStopped(directory, "express-mal");
		},
		25_000,
	);

	it.skipIf(!ohaAvailable)(
		"fails promptly when the diagnostic child exits before acknowledging a snapshot",
		async () => {
			const { binaries, directory, reference } = makeServers();
			process.env.TEST_ENV_LOG = path.join(directory, "environment.json");
			process.env.TEST_DIAGNOSTIC_MODE = "exit";
			await expect(
				runHttpGcDiagnostic(
					binaries.express,
					reference,
					path.join(directory, "diagnostic"),
					1,
					performance.now() + 15000,
				),
			).rejects.toThrow(/exited before a stats snapshot/);
			await expectStopped(directory, "express-node");
		},
		25_000,
	);

	it.skipIf(!ohaAvailable)(
		"rejects a successful status with the wrong body and stops the child",
		async () => {
			const { binaries, directory, reference } = makeServers();
			process.env.TEST_ENV_LOG = path.join(directory, "environment.json");
			process.env.TEST_MODE = "wrong-body";
			await expect(
				runHttpSnapshot(
					binaries,
					reference,
					path.join(directory, "evidence"),
					1,
					performance.now() + 30000,
				),
			).rejects.toThrow(/response mismatch/);
			await expectStopped(directory, "bare-mal");
			await expectStopped(directory, "bare-node");
		},
		45_000,
	);

	it("rejects a child that exits before reporting a complete port line", async () => {
		const { binaries, directory, reference } = makeServers();
		process.env.TEST_MODE = "exit-before-ready";
		await expect(
			runHttpSnapshot(
				binaries,
				reference,
				path.join(directory, "evidence"),
				1,
				performance.now() + 30000,
			),
		).rejects.toThrow(/failed before startup \(9\)/);
	});
});
