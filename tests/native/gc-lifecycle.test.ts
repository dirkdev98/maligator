import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-lifecycle-"));

describe("collector lifecycle", () => {
	let binary: string;

	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/gc-lifecycle.js",
			name: "gc-lifecycle",
			mainFile: "tests/fixtures/gc-lifecycle/main.c",
			outDir,
		});
	});

	it("abandons mark and sweep with a suspended generator before VM teardown", () => {
		const invocation = resolveHarnessExecutionInvocation(binary);
		const result = spawnSync(invocation.executable, invocation.args, {
			env: {
				...process.env,
				MAL_GC_THRESHOLD: "1",
				MAL_GC_MAJOR_EVERY: "1",
				MAL_GC_VERIFY: "1",
				MAL_GC_STATS: "1",
			},
			encoding: "utf8",
			timeout: scaledNativeRunTimeoutMs(120_000),
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe("gc-lifecycle PASS\n");
		if (!/\bworker_limit=0\b/.test(result.stderr)) {
			expect(
				Number(result.stderr.match(/\bworker_traces=(\d+)/)?.[1] ?? 0),
			).toBeGreaterThan(0);
		}
	});
});
