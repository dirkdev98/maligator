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

describe("GC root source lifecycle", () => {
	it("preserves distinct sources across hosted VMs and a hostless VM", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-root-source-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-root-source-lifecycle",
				mainFile: "tests/fixtures/gc-root-source-lifecycle/main.c",
				outDir,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: { ...process.env, MAL_GC_STATS: "1", MAL_GC_VERIFY: "1" },
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.signal || result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("gc-root-source-lifecycle PASS\n");
			expect(result.stderr.match(/^\[gc-stats\]/gm)).toHaveLength(1);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
