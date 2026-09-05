import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

describe("benchmark CLI", () => {
	it("plans the full cost of a bounded self-compile comparison without running it", () => {
		const directory = mkdtempSync(path.join(os.tmpdir(), "mal-bench-plan-"));
		onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
		const unusableCache = path.join(directory, "cache-is-a-file");
		writeFileSync(unusableCache, "plan must not lease this cache");
		const result = spawnSync(
			process.execPath,
			[
				"scripts/bench.ts",
				"self-compile",
				"--compare",
				"HEAD",
				"--runs",
				"1",
				"--max-pairs",
				"1",
				"--budget-seconds",
				"600",
				"--plan=json",
			],
			{ encoding: "utf8", env: { ...process.env, MALIGATOR_CACHE_DIR: unusableCache } },
		);
		expect(result.status, result.stderr).toBe(0);
		const plan = JSON.parse(result.stdout) as {
			comparison: Record<string, number>;
			perSnapshot: { selfCompileStages: Array<string> };
		};
		expect(plan.comparison).toMatchObject({
			warmupSnapshots: 2,
			maximumMeasuredSnapshots: 2,
			budgetSeconds: 600,
			incompleteExitCode: 2,
		});
		expect(plan.perSnapshot.selfCompileStages).toContain("cold pair 3/3");
		expect(plan.perSnapshot.selfCompileStages).toContain("runtime resource pair");
		expect(result.stderr).toBe("");
	});

	it.each([
		["--budget-seconds", "1"],
		["--resume", ".cache/missing"],
		["--compare", "HEAD", "--runs", "5", "--max-pairs", "1"],
	])("rejects invalid bounded comparison options %j before doing work", (...args) => {
		const result = spawnSync(process.execPath, ["scripts/bench.ts", ...args], {
			encoding: "utf8",
		});
		expect(result.status).not.toBe(0);
		expect(result.stdout).not.toContain("[bench");
	});
	it.each(["--help", "-h"])(
		"prints help and starts no benchmark lanes for %s",
		(flag) => {
			const result = spawnSync(process.execPath, ["scripts/bench.ts", flag], {
				cwd: process.cwd(),
				encoding: "utf8",
			});

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Usage: node scripts/bench.ts");
			expect(result.stdout).toContain("closed/open x");
			expect(result.stdout).toContain("self-compile");
			expect(result.stdout).toContain("--runs N");
			expect(result.stdout).toContain("--checkpoint PATH");
			expect(result.stdout).toContain("--ablate-core-family FAMILY");
			expect(result.stdout).not.toContain("[bench]");
			expect(result.stderr).toBe("");
		},
	);

	it("rejects retired lane names before starting benchmarks", () => {
		const result = spawnSync(process.execPath, ["scripts/bench.ts", "language"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});

		expect(result.status).not.toBe(0);
		expect(result.stdout).not.toContain("[bench]");
		expect(result.stderr).toContain("unknown benchmark family: language");
	});

	it("rejects unknown Core optimization-family ablations before benchmarking", () => {
		const result = spawnSync(
			process.execPath,
			["scripts/bench.ts", "javascript", "--ablate-core-family", "invented"],
			{ cwd: process.cwd(), encoding: "utf8" },
		);

		expect(result.status).not.toBe(0);
		expect(result.stdout).not.toContain("[bench]");
		expect(result.stderr).toContain("unknown Core optimization family: invented");
	});

	it("limits resumable checkpoints to a self-compile snapshot", () => {
		const result = spawnSync(
			process.execPath,
			[
				"scripts/bench.ts",
				"javascript",
				"--checkpoint",
				".cache/unreachable-checkpoint.json",
				"--json-out",
				".cache/unreachable-output.json",
			],
			{
				cwd: process.cwd(),
				encoding: "utf8",
			},
		);

		expect(result.status).not.toBe(0);
		expect(result.stdout).not.toContain("[bench]");
		expect(result.stderr).toContain(
			"--checkpoint requires only the self-compile benchmark family",
		);
	});
});
