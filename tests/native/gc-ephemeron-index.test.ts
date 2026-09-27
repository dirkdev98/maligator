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

describe("indexed ephemerons", () => {
	it("resolves reversed cross-map chains and drops unreachable cycles", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-ephemeron-index-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-ephemeron-index",
				mainFile: "tests/fixtures/gc-ephemeron-index/main.c",
				outDir,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_VERIFY: "1",
					MAL_GC_STATS: "1",
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("gc-ephemeron-index PASS\n");
			const visits = Number(result.stderr.match(/\bweak_entry_visits=(\d+)/)?.[1] ?? 0);
			expect(visits).toBeGreaterThanOrEqual(512);
			expect(visits).toBeLessThan(5120);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
