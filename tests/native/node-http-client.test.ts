import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-http-client-"));

describe("node:http outbound client", () => {
	let binaries: Array<string>;
	let earlyCloseBinaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/node-http-client-loopback.cjs",
				name: compiled ? "node-http-client-compiled" : "node-http-client-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			}),
		);
		earlyCloseBinaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/node-http-client-early-close.cjs",
				name: compiled
					? "node-http-client-early-close-compiled"
					: "node-http-client-early-close-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			}),
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
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new Error("missing early-close server address");
		}
		try {
			for (const binary of earlyCloseBinaries) {
				const output = await new Promise<string>((resolve, reject) => {
					const child = spawn(binary, [], {
						stdio: ["ignore", "pipe", "pipe"],
						env: {
							...process.env,
							MAL_HTTP_EARLY_CLOSE_PORT: String(address.port),
						},
					});
					let stdout = "";
					let stderr = "";
					child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
					child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
					const timer = setTimeout(() => {
						child.kill();
						reject(new Error("early-close client timed out"));
					}, 5000);
					child.once("exit", (code) => {
						clearTimeout(timer);
						if (code === 0) resolve(stdout);
						else reject(new Error(`early-close client failed: ${stderr}${stdout}`));
					});
				});
				expect(output).toContain("HTTP CLIENT EARLY CLOSE PASS");
			}
		} finally {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		}
	});
});
