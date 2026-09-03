import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("benchmark CLI", () => {
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
