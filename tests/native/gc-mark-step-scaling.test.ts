import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

describe("incremental major array trace attribution", () => {
	it("records 8K and 256K slot mutator traces without synchronous completion", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-mark-step-scaling-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-mark-step-scaling",
				mainFile: "tests/fixtures/gc-mark-step-scaling/main.c",
				outDir,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			for (const [mode, count] of [
				["small", 8192],
				["large", 262144],
			] as const) {
				const result = spawnSync(invocation.executable, [...invocation.args, mode], {
					env: {
						...process.env,
						MAL_GC_STATS: "1",
						MAL_GC_VERIFY: "1",
						MAL_GC_STRESS: "0",
						MAL_GC_MAJOR_EVERY: "1",
					},
					encoding: "utf8",
					timeout: scaledNativeRunTimeoutMs(120_000),
				});
				if (result.error !== undefined) throw result.error;
				expect(result.status, result.stderr || result.stdout).toBe(0);
				expect(result.stdout).toBe("gc-mark-step-scaling PASS\n");
				expect(result.stderr).toMatch(/\bsync_backstop=0\b/);
				expect(result.stderr).toMatch(
					new RegExp(`\\bmax_major_array_trace_slots=${count}\\b`),
				);
				expect(result.stderr).toMatch(/\bmax_major_array_trace_ms=\d+\.\d+\b/);
				expect(result.stderr).toMatch(/\bmax_mark_step_ms=\d+\.\d+\b/);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 180_000);
});
