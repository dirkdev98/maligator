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

const fixture = "tests/local/string-code-points.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-string-code-points-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("unboxed String iterator code points", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "string-code-points",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		}));
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	});

	it.each(["compiled", "interpreted"] as const)(
		"preserves UTF-16, fallthrough, escaping observations and patched protocols in %s mode",
		(mode) => {
			const binary = mode === "compiled" ? compiled : interpreted;
			for (const stress of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env: stress })).toBe(expected);
		},
	);

	it("executes scalar iterations and materializes only observed characters", () => {
		const result = spawnSync(compiled, [], {
			encoding: "utf8",
			env: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(expected);
		const stats = result.stderr.match(
			/\[perf-string-code-point-stats\] steps=(\d+) materializations=(\d+)/,
		);
		expect(stats, result.stderr).not.toBeNull();
		expect(Number(stats![1])).toBeGreaterThan(0);
		expect(Number(stats![2])).toBeGreaterThan(0);
		expect(Number(stats![2])).toBeLessThan(Number(stats![1]));
	});

	it("keeps literal states in integer tags until they escape", () => {
		const result = spawnSync(compiled, [], {
			encoding: "utf8",
			env: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(expected);
		const enums = result.stderr.match(
			/\[perf-string-enum-stats\] comparisons=(\d+) materializations=(\d+)/,
		);
		expect(enums, result.stderr).not.toBeNull();
		expect(Number(enums![1])).toBeGreaterThan(0);
		expect(Number(enums![2])).toBeGreaterThan(0);
	});
});
