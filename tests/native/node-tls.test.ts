import { execFile } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:tls";
import type { TLSSocket } from "node:tls";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-tls-"));
const ca = readFileSync("tests/fixtures/tls/localhost-cert.pem", "utf8");
const certificate = readFileSync("tests/fixtures/tls/localhost-server-cert.pem", "utf8");
const key = readFileSync("tests/fixtures/tls/localhost-server-key.pem", "utf8");

async function run(binary: string, insecure: boolean, stress: boolean): Promise<string> {
	const server = createServer({ cert: certificate, key }, (socket: TLSSocket) => {
		socket.on("data", (chunk: Buffer) => {
			if (chunk.toString("utf8") !== "ping")
				socket.destroy(new Error("unexpected request"));
			else socket.end("pong");
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("missing TLS port");
	try {
		return await new Promise<string>((resolve, reject) => {
			execFile(
				binary,
				[],
				{
					encoding: "utf8",
					env: {
						...process.env,
						...(stress ? STRESS_ENV : {}),
						TLS_CA: insecure ? "" : ca,
						TLS_INSECURE: insecure ? "1" : "0",
						TLS_PORT: String(address.port),
					},
					timeout: 20_000,
				},
				(error, stdout, stderr) => {
					if (error) {
						reject(
							new Error(
								`${error.message} code=${String(error.code)} signal=${String(error.signal)}\n${stdout}\n${stderr}`,
							),
						);
					} else resolve(stdout);
				},
			);
		});
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
}

describe("node:tls socket wrapping", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/local/node-tls-socket.cjs",
				name: compiled ? "node-tls-compiled" : "node-tls-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			}),
		);
	}, 600_000);

	it("wraps an existing socket with verified and insecure TLS", async () => {
		for (const binary of binaries) {
			expect(await run(binary, true, false)).toContain("NODE TLS PASS");
			expect(await run(binary, false, false)).toContain("NODE TLS PASS");
		}
	});

	it("keeps TLS socket state rooted under GC stress", async () => {
		for (const binary of binaries) {
			expect(await run(binary, false, true)).toContain("NODE TLS PASS");
		}
	});
});
