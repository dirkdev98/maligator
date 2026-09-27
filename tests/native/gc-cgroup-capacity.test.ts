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

describe("GC CPU quota discovery", () => {
	it("resolves mounted cgroup ancestry and bounds usable CPUs", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-cgroup-capacity-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-cgroup-capacity",
				mainFile: "tests/fixtures/gc-cgroup-capacity/main.c",
				outDir,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("gc-cgroup-capacity PASS\n");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
