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

const fixture = "tests/local/string-builder-accumulator.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-builder-accumulator-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("function-local string accumulators", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "string-builder-accumulator",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	});

	for (const mode of ["compiled", "interpreted"] as const) {
		it(`builds the same strings as Node.js at every observation in ${mode} mode`, () => {
			const binary = mode === "compiled" ? compiled : interpreted;
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		});
	}

	it("appends characters without allocating a string per append", () => {
		const invocation = resolveHarnessExecutionInvocation(compiled);
		const result = spawnSync(invocation.executable, invocation.args, {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(expected);
		const stats = result.stderr.match(
			/\[perf-string-builder-stats\] appends=(\d+) materializations=(\d+)/,
		);
		expect(stats, result.stderr).not.toBeNull();
		const loops = Number(result.stdout.match(/\bappendLoops=(\d+)/)?.[1]);
		// Each parsed path appends twelve characters and hands three segments onward.
		expect(Number(stats![1])).toBeGreaterThanOrEqual(loops * 12);
		expect(Number(stats![2])).toBeLessThan(Number(stats![1]));
	});
});
