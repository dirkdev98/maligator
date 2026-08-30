import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-direct-known-call-"));
const expected = ["direct-known-call PASS"];

describe("structural direct script-function calls", () => {
	let compiled: string;
	let interpreted: string;
	const frontendCacheEvents: Array<"hit" | "miss"> = [];

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/direct-known-call.js",
			name: "direct-known-call-compiled",
			compiled: true,
			mainFile: "runtime/direct_call_test_main.c",
			outDir,
			onFrontendCacheEvent: ({ cache }) => frontendCacheEvents.push(cache),
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/direct-known-call.js",
			name: "direct-known-call-interpreted",
			compiled: false,
			mainFile: "runtime/direct_call_test_main.c",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
			onFrontendCacheEvent: ({ cache }) => frontendCacheEvents.push(cache),
		});
	}, 600_000);

	it("preserves captures, this/callee identity, argument order, and overflow", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("enters interpreted targets directly and falls back on guard failure", () => {
		assertExactLines(runToStdout(interpreted), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	});

	it("fuses guarded branches and initialized global checks as logical executions", () => {
		const result = spawnSync(interpreted, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertExactLines(result.stdout, expected);
		const interpreterStats = result.stderr
			.split("\n")
			.find((line) => line.startsWith("[perf-interpreter-stats]"));
		expect(interpreterStats).toBeDefined();
		const field = (name: string): number =>
			Number(interpreterStats?.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
		const guardBranchFusions = field("guard_branch_fusions");
		const globalTdzFusions = field("global_tdz_fusions");
		const binaryBranchFusions = field("binary_branch_fusions");
		expect(guardBranchFusions).toBeGreaterThan(0);
		expect(globalTdzFusions).toBeGreaterThan(0);
		expect(binaryBranchFusions).toBeGreaterThan(0);
		expect(field("direct_leaf_executions")).toBeGreaterThanOrEqual(
			(guardBranchFusions + globalTdzFusions + binaryBranchFusions) * 2,
		);
	});

	it("reuses the shared program image across backend variants", () => {
		expect(frontendCacheEvents).toHaveLength(2);
		expect(frontendCacheEvents[1]).toBe("hit");
	});
});
