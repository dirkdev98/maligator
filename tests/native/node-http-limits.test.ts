import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-http-limits-"));

/** Run a binary to completion, failing on a non-zero exit or an event loop that
 * never drains — the deadline has to release its work, not just fire. */
function runWithEnv(binary: string, env: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ...env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`binary did not exit: ${stdout}${stderr}`));
		}, 10000);
		child.once("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(stdout);
			else reject(new Error(`binary exited ${code}: ${stderr}${stdout}`));
		});
	});
}

describe("node:http hardening configuration", () => {
	let limitBinaries: Array<string>;
	let timeoutBinaries: Array<string>;
	let setTimeoutBinaries: Array<string>;
	let silentServer: Server;
	let silentPort: number;
	const accepted: Array<Socket> = [];

	beforeAll(async () => {
		const build = (fixture: string, name: string) =>
			[true, false].map((compiled) =>
				buildNativeBinary({
					fixture,
					name: compiled ? `${name}-compiled` : `${name}-interpreted`,
					mainFile: HOST_MAIN,
					outDir,
					nodeEnabled: true,
					compiled,
				}),
			);
		limitBinaries = build("tests/local/node-http-limits.cjs", "node-http-limits");
		timeoutBinaries = build(
			"tests/local/node-http-client-timeout.cjs",
			"node-http-client-timeout",
		);
		setTimeoutBinaries = build(
			"tests/local/node-http-client-set-timeout.cjs",
			"node-http-client-set-timeout",
		);
		// Accepts the connection and then answers nothing at all: the peer that an
		// outbound deadline is the only defence against.
		silentServer = createServer((socket) => {
			accepted.push(socket);
			socket.on("error", () => undefined);
		});
		await new Promise<void>((resolve, reject) => {
			silentServer.once("error", reject);
			silentServer.listen(0, "127.0.0.1", resolve);
		});
		const address = silentServer.address();
		if (address === null || typeof address === "string") {
			throw new Error("missing silent server address");
		}
		silentPort = address.port;
	});

	afterAll(async () => {
		for (const socket of accepted) socket.destroy();
		await new Promise<void>((resolve) => {
			silentServer.close(() => resolve());
		});
	});

	it("exposes server limits as validated, live configuration", () => {
		for (const binary of limitBinaries) assertResultPass(runToStdout(binary));
	});

	it("terminates a silent peer through the request timeout option", async () => {
		for (const binary of timeoutBinaries) {
			const output = await runWithEnv(binary, {
				MAL_HTTP_TIMEOUT_PORT: String(silentPort),
			});
			expect(output).toContain("HTTP CLIENT TIMEOUT PASS");
		}
	});

	it("terminates a silent peer through request.setTimeout", async () => {
		for (const binary of setTimeoutBinaries) {
			const output = await runWithEnv(binary, {
				MAL_HTTP_TIMEOUT_PORT: String(silentPort),
			});
			expect(output).toContain("HTTP CLIENT SET TIMEOUT PASS");
		}
	});
});
