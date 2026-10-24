import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-http-client-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function buildClient(fixture: string, name: string, compiled: boolean): string {
	return buildNativeBinary({
		fixture,
		name,
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
		compiled,
	});
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("missing loopback server address");
	}
	return address.port;
}

function runClient(
	binary: string,
	env: NodeJS.ProcessEnv,
	args: Array<string> = [],
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(binary, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`${path.basename(binary)} timed out`));
		}, 15000);
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(`${path.basename(binary)} failed: ${stderr}${stdout}`));
		});
	});
}

/* Answers each request with its connection's ordinal and Connection header, so a client
 * can tell reuse apart; the cut and partial paths stop after three of ten body bytes. */
function failurePeer(): Server {
	let connections = 0;
	return createServer((socket) => {
		const connection = ++connections;
		let pending = "";
		socket.on("error", () => {});
		socket.on("data", (chunk) => {
			pending += chunk.toString("latin1");
			while (pending.includes("\r\n\r\n")) {
				const head = pending.slice(0, pending.indexOf("\r\n\r\n"));
				pending = pending.slice(head.length + 4);
				const target = head.split(" ")[1];
				if (
					target === "/truncate-fin" ||
					target === "/truncate-rst" ||
					target === "/partial"
				) {
					socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc");
					if (target === "/truncate-fin") setTimeout(() => socket.end(), 20);
					if (target === "/truncate-rst") setTimeout(() => socket.resetAndDestroy(), 20);
					continue;
				}
				const header = /\r\nconnection: *([^\r]*)/i.exec(head)?.[1] ?? "none";
				const body = `${connection}:${header}`;
				socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
			}
		});
	});
}

describe("node:http outbound client", () => {
	let binaries: Array<string>;
	let earlyCloseBinaries: Array<string>;
	let reusedCloseBinary: string;
	let failuresBinary: string;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildClient(
				"tests/local/node-http-client-loopback.cjs",
				compiled ? "node-http-client-compiled" : "node-http-client-interpreted",
				compiled,
			),
		);
		earlyCloseBinaries = [true, false].map((compiled) =>
			buildClient(
				"tests/local/node-http-client-early-close.cjs",
				compiled
					? "node-http-client-early-close-compiled"
					: "node-http-client-early-close-interpreted",
				compiled,
			),
		);
		reusedCloseBinary = buildClient(
			"tests/local/node-http-client-reused-close.cjs",
			"node-http-client-reused-close",
			true,
		);
		failuresBinary = buildClient(
			"tests/local/node-http-client-failures.cjs",
			"node-http-client-failures",
			true,
		);
	});

	it("streams requests and responses in compiled and interpreted modes", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary)).toContain("HTTP CLIENT LOOPBACK PASS");
		}
	});

	it("keeps client state rooted under GC stress in both modes", () => {
		for (const binary of binaries) {
			expect(runToStdout(binary, { env: STRESS_ENV })).toContain(
				"HTTP CLIENT LOOPBACK PASS",
			);
		}
	});

	it("terminates an incomplete upload when an early response closes the peer", async () => {
		const server = createServer((socket) => {
			let request = "";
			let responded = false;
			socket.on("data", (chunk) => {
				request += chunk.toString("latin1");
				if (responded || !request.includes("\r\n\r\n")) return;
				responded = true;
				socket.end(
					"HTTP/1.1 413 Payload Too Large\r\n" +
						"Content-Length: 0\r\nConnection: close\r\n\r\n",
				);
			});
		});
		const port = await listen(server);
		try {
			for (const binary of earlyCloseBinaries) {
				const output = await runClient(binary, {
					MAL_HTTP_EARLY_CLOSE_PORT: String(port),
				});
				expect(output).toContain("HTTP CLIENT EARLY CLOSE PASS");
			}
		} finally {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		}
	});

	it("gives Node's errors when a server drops a reused keep-alive socket", async () => {
		const closings = [
			{
				close: (socket: Socket) => socket.end(),
				error: { message: "socket hang up", code: "ECONNRESET" },
			},
			{
				close: (socket: Socket) => socket.resetAndDestroy(),
				error: {
					message: "read ECONNRESET",
					code: "ECONNRESET",
					syscall: "read",
					errno: -os.constants.errno.ECONNRESET,
				},
			},
		];
		for (const { close, error } of closings) {
			let droppedReusedSocket = false;
			const server = createServer((socket) => {
				let pending = "";
				let served = 0;
				socket.on("error", () => {});
				socket.on("data", (chunk) => {
					pending += chunk.toString("latin1");
					while (pending.includes("\r\n\r\n")) {
						pending = pending.slice(pending.indexOf("\r\n\r\n") + 4);
						served++;
						if (served === 1) {
							socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
						} else {
							droppedReusedSocket = true;
							close(socket);
						}
					}
				});
			});
			const port = await listen(server);
			try {
				const output = await runClient(reusedCloseBinary, {
					MAL_HTTP_REUSED_CLOSE_PORT: String(port),
				});
				expect(droppedReusedSocket).toBe(true);
				expect(JSON.parse(output)).toEqual(error);
			} finally {
				await new Promise<void>((resolve) => {
					server.close(() => resolve());
				});
			}
		}
	});

	it("reports failed connections, cut responses and agent pooling as Node does", async () => {
		const fixture = "tests/local/node-http-client-failures.cjs";
		const outputs: Array<string> = [];
		for (const [command, args, env] of [
			[process.execPath, [fixture], {}],
			[failuresBinary, [], {}],
			[failuresBinary, [], STRESS_ENV],
		] as const) {
			const peers = [failurePeer(), failurePeer()];
			const [port, poolPort] = await Promise.all(peers.map(listen));
			try {
				outputs.push(
					await runClient(
						command,
						{
							...env,
							MAL_HTTP_FAILURES_PORT: String(port),
							MAL_HTTP_FAILURES_POOL_PORT: String(poolPort),
						},
						[...args],
					),
				);
			} finally {
				await Promise.all(
					peers.map(
						(peer) =>
							new Promise<void>((resolve) => {
								peer.close(() => resolve());
							}),
					),
				);
			}
		}
		const [node, maligator, stressed] = outputs;
		expect(node).toContain("default second: reused=true same=true connection=keep-alive");
		expect(node).toContain('"code":"ECONNREFUSED"');
		expect(maligator).toBe(node);
		expect(stressed).toBe(node);
	});
});
