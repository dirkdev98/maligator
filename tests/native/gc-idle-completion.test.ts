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

describe("GC idle completion", () => {
	it("finishes an active major before host exit, reactor wait, and scheduler exit", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-idle-completion-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-idle-completion",
				mainFile: "tests/fixtures/gc-idle-completion/main.c",
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
			expect(result.status, result.signal || result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("gc-idle-completion PASS\n");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
