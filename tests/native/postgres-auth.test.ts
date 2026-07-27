import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN, STRESS_ENV } from "../../src/test-harness.ts";
import { startPostgresAuthPeer } from "../helpers/postgres-auth-peer.ts";
import type { PostgresAuthMode } from "../helpers/postgres-auth-peer.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-postgres-auth-"));
const tlsCa = readFileSync("tests/fixtures/tls/localhost-cert.pem", "utf8");
const tlsCertificate = readFileSync("tests/fixtures/tls/localhost-server-cert.pem", "utf8");
const tlsKey = readFileSync("tests/fixtures/tls/localhost-server-key.pem", "utf8");

function run(binary: string, port: number, env = process.env): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			binary,
			[],
			{
				encoding: "utf8",
				env: { ...process.env, ...env, PGPORT: String(port) },
				timeout: 20_000,
			},
			(error, stdout, stderr) => {
				if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
				else resolve(stdout);
			},
		);
	});
}

describe("postgres.js authentication", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = [true, false].map((compiled) =>
			buildNativeBinary({
				fixture: "tests/fixtures/postgres-js/auth.mjs",
				name: compiled ? "postgres-auth-compiled" : "postgres-auth-interpreted",
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				webPlatformEnabled: false,
				compiled,
			}),
		);
	}, 600_000);

	async function check(mode: PostgresAuthMode, env?: NodeJS.ProcessEnv): Promise<void> {
		for (const binary of binaries) {
			const peer = await startPostgresAuthPeer(mode);
			try {
				expect(await run(binary, peer.port, env)).toContain("RESULT 1/1");
			} finally {
				await peer.close();
			}
		}
	}

	it("authenticates with cleartext, PostgreSQL MD5, and SCRAM-SHA-256", async () => {
		for (const mode of ["cleartext", "md5", "scram"] satisfies Array<PostgresAuthMode>) {
			await check(mode);
		}
	});

	it("keeps SCRAM state rooted under GC stress", async () => {
		await check("scram", STRESS_ENV);
	});

	it("authenticates SCRAM over direct TLS with ALPN", async () => {
		for (const binary of binaries) {
			for (const insecure of [false, true]) {
				const peer = await startPostgresAuthPeer("scram", {
					tls: { certificate: tlsCertificate, key: tlsKey },
				});
				try {
					expect(
						await run(binary, peer.port, {
							PGHOST: "localhost",
							PGSSL_CA: insecure ? "" : tlsCa,
							PGSSL_DIRECT: "1",
							PGSSL_INSECURE: insecure ? "1" : "0",
						}),
					).toContain("RESULT 1/1");
				} finally {
					await peer.close();
				}
			}
		}
	});
});
