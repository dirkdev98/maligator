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

describe("FFI weak handle recovery", () => {
	it("preserves live aliases during marking and reserves pending cleanup during sweep", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-ffi-handle-sweep-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "ffi-handle-sweep",
				mainFile: "tests/fixtures/ffi-handle-sweep/main.c",
				outDir,
				evalEnabled: false,
				realmsEnabled: false,
				intlEnabled: false,
				temporalEnabled: false,
				regexpEnabled: false,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_VERIFY: "1",
					MAL_GC_MAJOR_EVERY: "1",
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("ffi-handle-sweep PASS\n");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
