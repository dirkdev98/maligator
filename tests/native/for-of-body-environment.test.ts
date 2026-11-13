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

const fixture = "tests/local/for-of-body-environment.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-for-of-body-environment-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("for-of environments with captured body bindings", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "for-of-body-environment",
			outDir,
			evalEnabled: true,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	});

	for (const mode of ["compiled", "interpreted"] as const) {
		it(`preserves captured cells and iterator cleanup in ${mode} mode`, () => {
			const binary = mode === "compiled" ? compiled : interpreted;
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		});
	}

	it("skips per-call scope allocation when the body is never entered", () => {
		for (const binary of [compiled, interpreted]) {
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: { ...process.env, MAL_PERF_STATS: "1" },
				encoding: "utf8",
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe(expected);
			const count = Number(result.stderr.match(/\bscope_environments=(\d+)/)?.[1]);
			const emptyCalls = Number(result.stdout.match(/\bemptyCalls=(\d+)/)?.[1]);
			expect(count).toBeGreaterThan(0);
			// Startup and nonempty controls also allocate synthetic scope environments.
			expect(count).toBeLessThan(emptyCalls);
		}
	});
});
