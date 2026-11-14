import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/array-includes-direct.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-array-includes-direct-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("guarded dense Array includes", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "array-includes-direct",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	});

	it.each(["compiled", "interpreted"] as const)(
		"preserves indexed search and observable fallbacks in %s mode",
		(mode) => {
			const binary = mode === "compiled" ? compiled : interpreted;
			expect(runToStdout(binary)).toBe(expected);
		},
	);

	it("keeps search operands alive under GC stress", () => {
		for (const binary of [compiled, interpreted])
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
	});

	it("executes dense searches and retains generic fallbacks", () => {
		const result = spawnSync(compiled, [], {
			encoding: "utf8",
			env: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(expected);
		const stats = result.stderr.match(
			/\[perf-array-search-stats\] includes_direct_hits=(\d+) includes_direct_fallbacks=(\d+)/,
		);
		expect(stats, result.stderr).not.toBeNull();
		expect(Number(stats![1])).toBeGreaterThan(0);
		expect(Number(stats![2])).toBeGreaterThan(0);
	});
});
