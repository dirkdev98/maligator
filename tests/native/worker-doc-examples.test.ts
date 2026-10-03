import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const examples = [
	["declaration", "true true\n"],
	["pool", "6\n3\n7\ntrue\n"],
	["transfer", "0\n3,2,1\n"],
	["worker", "workers\nterminated\n"],
	["configuration", "thumbnail\n"],
	["channel", 'true\n{"answer":42}\n'],
	["port", "reply:hello\n"],
	["receive", "first\nsecond\nundefined\n"],
	["capabilities", "true true\ntrue true\n"],
] as const;

for (const compiled of [true, false]) {
	for (const [entry, expected] of examples) {
		it(`runs the ${entry} documentation example (${compiled ? "native" : "interpreted"})`, () => {
			const outDir = mkdtempSync(path.join(tmpdir(), "mal-worker-doc-example-"));
			try {
				const binary = buildNativeBinary({
					fixture: `tests/local/worker-doc-examples/${entry}.ts`,
					name: `worker-doc-${entry}-${compiled ? "native" : "interpreted"}`,
					outDir,
					compiled,
				});
				const invocation = resolveHarnessExecutionInvocation(binary);
				for (const extra of [{}, STRESS_ENV]) {
					const env = { ...process.env, ...extra };
					const result = spawnSync(invocation.executable, invocation.args, {
						encoding: "utf8",
						env,
						timeout: scaledNativeRunTimeoutMs(15_000, env),
					});
					if (result.error !== undefined) throw result.error;
					expect(result.status, result.stderr || result.stdout).toBe(0);
					expect(result.stderr).toBe("");
					expect(result.stdout).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		}, 300_000);
	}
}
