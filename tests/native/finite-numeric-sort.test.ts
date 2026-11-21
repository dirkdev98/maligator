import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/finite-numeric-sort.mjs";

describe.each([false, true])("finite numeric sorts (realms=%s)", (realms) => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	const outDir = mkdtempSync(join(tmpdir(), "mal-finite-numeric-sort-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	beforeAll(() => {
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: `finite-numeric-sort-${realms}`,
			outDir,
			mainFile: HOST_MAIN,
			production: true,
			config: resolveBuildConfig({
				engine: { eval: false, realms, primordials: "mutable" },
			}),
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	it("runs typed whole-sort kernels while preserving stable results and copy identity", () => {
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
		}).trim();
		const result = spawnSync(pair.compiled, [], {
			encoding: "utf8",
			env: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(expected);
		const kernels = result.stderr.match(/numeric_sort_kernel_runs=(\d+)/);
		expect(kernels, result.stderr).not.toBeNull();
		expect(Number(kernels![1])).toBeGreaterThan(0);
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary).trim()).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV }).trim()).toBe(expected);
		}
	});

	it("retains NaN, BigInt, replacement and throwing comparator behavior", () => {
		const env = { ...STRESS_ENV, FINITE_SORT_CASE: "fallback" };
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		}).trim();
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env }).trim()).toBe(expected);
	});
});
