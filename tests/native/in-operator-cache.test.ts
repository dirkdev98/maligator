import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/in-operator-cache.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-in-operator-cache-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("cached in-operator answers", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "in-operator-cache",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	});

	for (const mode of ["compiled", "interpreted"] as const) {
		it(`follows prototype, shape, proxy, and key changes in ${mode} mode`, () => {
			const binary = mode === "compiled" ? compiled : interpreted;
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		});
	}

	it("answers repeated misses on a plain object from the cache", () => {
		for (const binary of [compiled, interpreted]) {
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: { ...process.env, MAL_PERF_STATS: "1" },
				encoding: "utf8",
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe(expected);
			const hits = Number(result.stderr.match(/\bhas_cache_hits=(\d+)/)?.[1]);
			const misses = Number(result.stdout.match(/\brepeatedMisses=(\d+)/)?.[1]);
			// Each distinct key fills once; every later repetition is answered by its row.
			expect(hits).toBeGreaterThanOrEqual(misses * 0.99);
		}
	});
});
