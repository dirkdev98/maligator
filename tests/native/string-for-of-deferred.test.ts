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

const fixture = "tests/local/string-for-of-deferred.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-for-of-deferred-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("for-of over primitive strings without an iterator object", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "string-for-of-deferred",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	});

	for (const mode of ["compiled", "interpreted"] as const) {
		it(`yields code points and closes like a String Iterator in ${mode} mode`, () => {
			const binary = mode === "compiled" ? compiled : interpreted;
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		});
	}

	it("iterates intact-protocol strings without allocating iterators", () => {
		const invocation = resolveHarnessExecutionInvocation(compiled);
		const result = spawnSync(invocation.executable, invocation.args, {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(expected);
		const deferred = Number(
			result.stderr.match(/\bdeferred_string_iterators=(\d+)/)?.[1],
		);
		const loops = Number(result.stdout.match(/\bloops=(\d+)/)?.[1]);
		expect(deferred).toBeGreaterThanOrEqual(loops);
	});
});
