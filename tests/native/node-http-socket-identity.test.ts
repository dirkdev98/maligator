import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { Agent, get } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	captureChildExit,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
	waitForChildExit,
	waitForPort,
} from "../../src/test-harness.ts";

const fixture = "tests/local/node-http-socket-identity.cjs";
const outDir = mkdtempSync(path.join(tmpdir(), "mal-http-socket-identity-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

interface Observation {
	id: number;
	requests: number;
	events: number;
	aliases: boolean;
	method: boolean;
	address: boolean;
}

function request(port: number, route: string, agent: Agent | false): Promise<string> {
	return new Promise((resolve, reject) => {
		const outgoing = get({ host: "127.0.0.1", port, path: route, agent }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => (body += chunk));
			response.on("end", () => resolve(body));
			response.once("error", reject);
		});
		outgoing.on("error", reject);
		outgoing.setTimeout(5000, () => {
			outgoing.destroy(new Error("socket identity request timed out"));
		});
	});
}

function check(observation: Observation, count: number): void {
	expect(observation).toMatchObject({
		requests: count,
		events: count,
		aliases: true,
		method: true,
		address: true,
	});
}

async function exercise(
	executable: string,
	args: ReadonlyArray<string>,
	env: NodeJS.ProcessEnv,
): Promise<string> {
	const child = spawn(executable, args, {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});
	const exit = captureChildExit(child);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	const first = new Agent({ keepAlive: true, maxSockets: 1 });
	const second = new Agent({ keepAlive: true, maxSockets: 1 });
	try {
		const port = await waitForPort(child);
		const initial = JSON.parse(await request(port, "/", first)) as Observation;
		check(initial, 1);
		await request(port, "/gc", false);
		const reused = JSON.parse(await request(port, "/retain", first)) as Observation;
		check(reused, 2);
		expect(reused.id).toBe(initial.id);
		const separate = JSON.parse(await request(port, "/", second)) as Observation;
		check(separate, 1);
		expect(separate.id).not.toBe(initial.id);
		await request(port, "/gc", false);
		const reusedSeparate = JSON.parse(await request(port, "/", second)) as Observation;
		check(reusedSeparate, 2);
		expect(reusedSeparate.id).toBe(separate.id);
		const pipelined = await new Promise<string>((resolve, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port }, () => {
				socket.end(
					"GET / HTTP/1.1\r\nHost: localhost\r\n\r\nGET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
				);
			});
			let body = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk: string) => (body += chunk));
			socket.on("end", () => resolve(body));
			socket.on("error", reject);
			socket.setTimeout(5000, () => socket.destroy(new Error("pipeline timed out")));
		});
		const observations = [...pipelined.matchAll(/\{"id":\d+[^}]+\}/g)].map(
			([body]) => JSON.parse(body) as Observation,
		);
		expect(observations).toHaveLength(2);
		check(observations[0]!, 1);
		check(observations[1]!, 2);
		expect(observations[0]!.id).toBe(observations[1]!.id);
		first.destroy();
		second.destroy();
		await request(port, "/gc", false);
		expect(await request(port, "/retained", false)).toBe(`${initial.id}:2:2`);
		expect(await request(port, "/close", false)).toBe("closed");
		expect(await waitForChildExit(exit, 5000), stderr).toBe(0);
		return stderr;
	} finally {
		first.destroy();
		second.destroy();
		child.kill("SIGKILL");
	}
}

describe("HTTP socket connection identity", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "http-socket-identity",
			outDir,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({ surface: { node: true, webPlatform: true } }),
			production: true,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
	});
	it("matches Node connection identity and mutable application state", async () => {
		await exercise(process.execPath, ["--expose-gc", fixture], {});
	});
	it("preserves state across compiled requests and releases connections", async () => {
		const invocation = resolveHarnessExecutionInvocation(compiled);
		const stderr = await exercise(invocation.executable, invocation.args, {
			MAL_HOST_GC: "1",
			MAL_PERF_STATS: "1",
		});
		const line = stderr.split("\n").find((row) => row.startsWith("[perf-http-stats]"));
		expect(line).toBeDefined();
		const counter = (name: string): number => {
			const match = line!.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)(?:\\s|$)`));
			expect(match, name).not.toBeNull();
			return Number(match![1]);
		};
		const creations = counter("socket_context_creations");
		expect(creations).toBeGreaterThan(0);
		expect(counter("socket_context_reuses")).toBeGreaterThan(0);
		expect(counter("socket_context_releases")).toBe(creations);
	});
	it("preserves state across interpreted requests", async () => {
		const invocation = resolveHarnessExecutionInvocation(interpreted);
		await exercise(invocation.executable, invocation.args, { MAL_HOST_GC: "1" });
	});
	it("roots idle sockets, listeners and retained facades under GC stress", async () => {
		const invocation = resolveHarnessExecutionInvocation(compiled);
		await exercise(invocation.executable, invocation.args, {
			MAL_HOST_GC: "1",
			...STRESS_ENV,
		});
	});
});
