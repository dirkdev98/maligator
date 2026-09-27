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

describe("remembered owner scan attribution", () => {
	it.each([
		["sparse", 1],
		["dense", 8192],
	] as const)("measures %s old array writes", (mode, discoveries) => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-remembered-scan-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-remembered-scan",
				mainFile: "tests/fixtures/gc-remembered-scan/main.c",
				outDir,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, [...invocation.args, mode], {
				env: {
					...process.env,
					MAL_GC_STATS: "1",
					MAL_GC_VERIFY: "1",
					MAL_GC_STRESS: "0",
					MAL_GC_MAJOR_EVERY: "8",
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("gc-remembered-scan PASS\n");
			expect(result.stderr).toMatch(/\bheap_usage_at=pre_teardown\b/);
			expect(
				Number(result.stderr.match(/\braw_owned_bytes=(\d+)/)?.[1] ?? 0),
			).toBeGreaterThan(0);
			expect(result.stderr).toMatch(/remembered_array_owners=1\b/);
			expect(result.stderr).toMatch(/remembered_array_slots=8192\b/);
			expect(result.stderr).toMatch(
				new RegExp(`remembered_array_discoveries=${discoveries}\\b`),
			);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
