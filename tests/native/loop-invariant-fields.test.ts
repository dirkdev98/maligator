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

const fixture = "tests/local/loop-invariant-fields.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-loop-invariant-fields-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("numeric loops reading fields of invariant objects", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "loop-invariant-fields",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	});

	for (const mode of ["compiled", "interpreted"] as const) {
		it(`reads each field like an ordinary property access in ${mode} mode`, () => {
			const binary = mode === "compiled" ? compiled : interpreted;
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		});
	}

	it("runs the warm loops as numeric regions", () => {
		const invocation = resolveHarnessExecutionInvocation(compiled);
		const result = spawnSync(invocation.executable, invocation.args, {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(expected);
		const admissions = Number(
			result.stderr.match(/\[perf-loop-invariant-stats\] admissions=(\d+)/)?.[1],
		);
		const loops = Number(result.stdout.match(/\bloops=(\d+)/)?.[1]);
		// Each warm-up round runs seven loops that read invariant fields.
		expect(admissions).toBeGreaterThanOrEqual(7 * loops);
	});
});
