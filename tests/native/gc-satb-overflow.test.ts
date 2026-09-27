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

describe("bounded SATB batches", () => {
	it("retains over two deleted-edge batches across an unrooted native frame", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-satb-overflow-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-satb-overflow",
				mainFile: "tests/fixtures/gc-satb-overflow/main.c",
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
			expect(result.status, result.signal || result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("gc-satb-overflow PASS\n");
			expect(
				Number(result.stderr.match(/\bsatb_flushes=(\d+)/)?.[1] ?? 0),
			).toBeGreaterThanOrEqual(3);
			expect(Number(result.stderr.match(/\bsatb_high_water=(\d+)/)?.[1] ?? 0)).toBe(4096);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
