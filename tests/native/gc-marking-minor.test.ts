import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

const directory = mkdtempSync(path.join(os.tmpdir(), "mal-gc-marking-minor-"));
let binary: string;

beforeAll(() => {
	binary = buildNativeBinary({
		fixture: "tests/local/fibertest_stub.js",
		mainFile: "tests/fixtures/gc-marking-minor/main.c",
		name: "gc-marking-minor",
		outDir: directory,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		webPlatformEnabled: false,
		regexpEnabled: false,
		temporalEnabled: false,
	});
}, 300_000);

afterAll(() => rmSync(directory, { recursive: true, force: true }));

for (const workers of [0, 1]) {
	it(`reclaims young garbage before remark and retains SATB, weak and atom roots with ${workers} workers`, () => {
		const invocation = resolveHarnessExecutionInvocation(binary);
		const result = spawnSync(
			invocation.executable,
			[...invocation.args, String(workers)],
			{
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_MAJOR_EVERY: "1",
					MAL_GC_VERIFY: "1",
					MAL_GC_STATS: "1",
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(30_000),
			},
		);
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe("gc-marking-minor PASS\n");
		expect(
			Number(result.stderr.match(/\bmarking_minors=(\d+)/)?.[1] ?? 0),
		).toBeGreaterThan(0);
	});
}
