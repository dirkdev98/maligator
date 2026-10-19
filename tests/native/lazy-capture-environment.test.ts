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

const fixture = "tests/local/lazy-capture-environment.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-lazy-capture-environment-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

function allocationStats(binary: string): string {
	const invocation = resolveHarnessExecutionInvocation(binary);
	const result = spawnSync(invocation.executable, invocation.args, {
		env: { ...process.env, MAL_PERF_STATS: "1" },
		encoding: "utf-8",
	});
	expect(result.status, result.stderr || result.stdout).toBe(0);
	const line = result.stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-allocation-stats]"));
	expect(line).toBeDefined();
	return line ?? "";
}

describe("lazy capture environments", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "lazy-capture-environment",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	}, 600_000);

	it("keep captured bindings consistent before, across and after the environment exists", () => {
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
		}
	});

	it("allocate no environment for calls that return before creating a closure", () => {
		const eager = field(allocationStats(interpreted), "capture_environments");
		const lazy = allocationStats(compiled);
		// The fixture's 2000 disabled logger calls each allocate one environment when eager.
		expect(eager).toBeGreaterThanOrEqual(2000);
		expect(field(lazy, "capture_environments")).toBeLessThan(eager - 1900);
		expect(field(lazy, "deferred_capture_environments")).toBeGreaterThan(0);
	});
});
