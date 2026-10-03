import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	runToStdout,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

for (const compiled of [true, false]) {
	it(`owns transfers, shares memory and schedules cancellable tasks (${compiled ? "native" : "interpreted"})`, () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-workers-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/workers/main.mjs",
				name: `workers-${compiled ? "native" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 30_000 })).toBe(
				"workers PASS\n",
			);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 300_000);
}

for (const compiled of [true, false]) {
	it(`runs unmodified Tinypool with its default Atomics protocol (${compiled ? "native" : "interpreted"})`, () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-tinypool-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/tinypool-workers/main.mjs",
				name: `tinypool-workers-${compiled ? "native" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(30_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toBe("tinypool-workers PASS\n");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 300_000);
}
