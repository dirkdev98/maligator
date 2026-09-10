import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

it("completes uninstrumented scaling with equal cold/warm output and no invented instruction counts", () => {
	const temporary = mkdtempSync(path.join(os.tmpdir(), "mal-scale-runner-test-"));
	try {
		const output = path.join(temporary, "report.json");
		const result = spawnSync(
			process.execPath,
			[
				"scripts/bench-compiler-scale.ts",
				"--tier",
				"1",
				"--warm-runs",
				"1",
				"--cold-runs",
				"1",
				"--instrumentation",
				"off",
				"--no-profile",
				"--output",
				output,
			],
			{ encoding: "utf8", timeout: 60_000 },
		);
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(readFileSync(output, "utf8")) as {
			complete: boolean;
			results: Array<{
				warm: { samples: Array<{ output: unknown }> };
				cold: { samples: Array<{ output: unknown }> };
			}>;
			syntheticScaling: Array<{ samples: Array<{ inputInstructions: number | null }> }>;
		};
		expect(report.complete).toBe(true);
		expect(report.results).toHaveLength(3);
		for (const sample of report.results)
			expect(sample.cold.samples[0]?.output).toEqual(sample.warm.samples[0]?.output);
		for (const sample of report.syntheticScaling[0]!.samples)
			expect(sample.inputInstructions).toBeNull();
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
