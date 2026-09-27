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

describe("concurrent object edge snapshots", () => {
	for (const spec of [
		{
			name: "gc-snapshot-overlap",
			mainFile: "tests/fixtures/gc-snapshot-overlap/main.c",
			intent: "retains copied dense edges across overwrite, delete, and resize",
		},
		{
			name: "gc-snapshot-object",
			mainFile: "tests/fixtures/gc-snapshot-object/main.c",
			intent: "retains copied shaped edges across value and layout changes",
		},
	])
		it(spec.intent, (ctx) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-snapshot-overlap-"));
			try {
				const binary = buildNativeBinary({
					fixture: "tests/local/fibertest_stub.js",
					name: spec.name,
					mainFile: spec.mainFile,
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
				if (result.stdout === `${spec.name} SKIP\n`) {
					expect(result.stderr).toMatch(/\bworker_limit=0\b/);
					ctx.skip("GC workers unavailable at this CPU capacity");
				}
				expect(result.stdout).toBe(`${spec.name} PASS\n`);
				expect(
					Number(result.stderr.match(/\bsnapshot_discoveries=(\d+)/)?.[1] ?? 0),
				).toBeGreaterThan(0);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		});
});
