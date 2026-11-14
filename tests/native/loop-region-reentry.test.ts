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

const fixture = "tests/local/loop-region-reentry.cjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-loop-region-reentry-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function printed(stdout: string, name: string): number {
	const match = new RegExp(`^${name}=(\\d+)$`, "m").exec(stdout);
	if (match === null) throw new Error(`fixture output lacks ${name}`);
	return Number(match[1]);
}

describe("numeric loop regions resumed after a restarted iteration", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "loop-region-reentry",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	}, 600_000);

	for (const mode of ["compiled", "interpreted"] as const) {
		it(`finishes every restarted iteration like the original loop in ${mode} mode`, () => {
			const binary = mode === "compiled" ? compiled : interpreted;
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 120_000 })).toBe(expected);
		});
	}

	describe("region returns", () => {
		let reentries: number;
		beforeAll(() => {
			const invocation = resolveHarnessExecutionInvocation(compiled);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: { ...process.env, MAL_PERF_STATS: "1" },
				encoding: "utf8",
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe(expected);
			const match = /\[perf-loop-region-reentries\] reentries=(\d+)/.exec(result.stderr);
			expect(match, result.stderr).not.toBeNull();
			reentries = Number(match![1]);
		});

		it("returns to the region once the original loop finishes the restarted iteration", () => {
			// Each warm loop restarts on its first element and finishes in the region.
			expect(reentries).toBeGreaterThanOrEqual(printed(expected, "restarting"));
		});

		it("stops returning to a loop whose every iteration restarts", () => {
			expect(reentries).toBeLessThan(printed(expected, "failing"));
		});
	});
});
