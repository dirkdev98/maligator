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

describe("dense array owner cards", () => {
	it("preserves young children moved within old arrays and inserted by bulk methods", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-dense-card-moves-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-dense-card-moves",
				mainFile: "tests/fixtures/gc-dense-card-moves/main.c",
				outDir,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_MAJOR_EVERY: "8",
					MAL_GC_VERIFY: "1",
					MAL_GC_STATS: "1",
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("gc-dense-card-moves PASS\n");
			expect(Number(result.stderr.match(/\bminor=(\d+)/)?.[1] ?? 0)).toBeGreaterThan(0);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
