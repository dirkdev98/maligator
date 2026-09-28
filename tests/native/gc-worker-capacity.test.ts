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

describe("GC worker capacity", () => {
	it("retains and reclaims wide graphs with zero, one, and two workers across VM reinitialization", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-worker-capacity-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-worker-capacity",
				mainFile: "tests/fixtures/gc-worker-capacity/main.c",
				outDir,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_MAJOR_EVERY: "1",
					MAL_GC_VERIFY: "1",
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("gc-worker-capacity PASS\n");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
