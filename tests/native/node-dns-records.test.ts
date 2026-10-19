import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

for (const compiled of [true, false]) {
	describe(`node:dns record queries (compiled=${compiled})`, () => {
		let outDir: string | undefined;
		let binary: string;
		beforeAll(() => {
			outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-dns-records-"));
			binary = buildNativeBinary({
				fixture: "tests/local/node-dns-records.mjs",
				name: `node-dns-records-${compiled ? "compiled" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
		});
		afterAll(() => {
			if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
		});
		test(`parses record answers and errors from a loopback DNS server (compiled=${compiled})`, () => {
			const invocation = resolveHarnessExecutionInvocation(binary);
			for (const env of [{}, STRESS_ENV]) {
				const result = spawnSync(invocation.executable, invocation.args, {
					encoding: "utf8",
					env: { ...process.env, ...env },
					timeout: scaledNativeRunTimeoutMs(60_000),
				});
				if (result.error !== undefined) throw result.error;
				expect(result.status, result.stderr || result.stdout).toBe(0);
				expect(result.stderr).toBe("");
				expect(result.stdout).toBe("node-dns-records PASS\n");
			}
		}, 300_000);
	});
}
