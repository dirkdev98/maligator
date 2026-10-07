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
	describe(`Node posting policy (compiled=${compiled})`, () => {
		let outDir: string | undefined;
		let binary: string;
		beforeAll(() => {
			outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-post-policy-"));
			binary = buildNativeBinary({
				fixture: "tests/local/node-worker-post-policy/main.mjs",
				name: `node-worker-post-policy-${compiled ? "compiled" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
		});
		afterAll(() => {
			if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
		});
		test(`Node ports preserve their posting policy across transfer alongside transactional ports (compiled=${compiled})`, () => {
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
				expect(result.stdout).toBe("node-worker-post-policy PASS\n");
			}
		}, 300_000);
	});
}
