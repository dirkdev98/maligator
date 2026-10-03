import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

test.each([true, false])(
	"Node ports preserve their posting policy across transfer alongside transactional ports (compiled=%s)",
	(compiled) => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-post-policy-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/node-worker-post-policy/main.mjs",
				name: `node-worker-post-policy-${compiled ? "compiled" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
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
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	},
	300_000,
);
