import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

it("retains canonical atoms, registered symbols and cached sources through minor GC and growth during incremental major GC", () => {
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-intern-stores-"));
	try {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "intern-stores",
			mainFile: "tests/fixtures/intern-stores/main.c",
			outDir,
		});
		const invocation = resolveHarnessExecutionInvocation(binary);
		const result = spawnSync(invocation.executable, invocation.args, {
			env: {
				...process.env,
				MAL_GC_VERIFY: "1",
				MAL_GC_STRESS: "0",
				MAL_GC_MAJOR_EVERY: "8",
				MAL_GC_STATS: "1",
			},
			encoding: "utf8",
			timeout: scaledNativeRunTimeoutMs(120_000),
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toMatch(
			/^intern-stores bytes atoms=\d+ registry=\d+ sources=\d+ properties=\d+\nintern-stores PASS\n$/,
		);
		expect(Number(result.stderr.match(/\bminor=(\d+)/)?.[1] ?? 0)).toBeGreaterThan(0);
		expect(Number(result.stderr.match(/\bmajor=(\d+)/)?.[1] ?? 0)).toBeGreaterThan(0);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 600_000);
