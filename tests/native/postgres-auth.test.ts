import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN, STRESS_ENV } from "../../src/test-harness.ts";
import { startPostgresAuthPeer } from "../helpers/postgres-auth-peer.ts";
import type { PostgresAuthMode } from "../helpers/postgres-auth-peer.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-postgres-auth-"));

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
});
