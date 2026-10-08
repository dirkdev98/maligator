import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

it.each([
	{ label: "warm/cold", warmRuns: 1, coldRuns: 1 },
	{ label: "cold-only", warmRuns: 0, coldRuns: 3 },
])(
	"completes $label scaling with output parity and no invented instruction counts",
	({ warmRuns, coldRuns }) => {
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
					String(warmRuns),
					"--cold-runs",
					String(coldRuns),
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
					protocol: { warmDefinition: string };
					warm: { samples: Array<{ output: unknown }> };
					cold: { samples: Array<{ output: unknown }> };
				}>;
				syntheticScaling: Array<{ samples: Array<{ inputInstructions: number | null }> }>;
			};
			expect(report.complete).toBe(true);
			expect(report.results).toHaveLength(3);
			for (const sample of report.results) {
				expect(sample.warm.samples).toHaveLength(warmRuns);
				expect(sample.cold.samples).toHaveLength(coldRuns);
				const reference = sample.warm.samples[0] ?? sample.cold.samples[0];
				for (const cold of sample.cold.samples)
					expect(cold.output).toEqual(reference?.output);
				if (warmRuns === 0)
					expect(sample.protocol.warmDefinition).toBe(
						"no warm samples or untimed warmup",
					);
			}
			for (const sample of report.syntheticScaling[0]!.samples)
				expect(sample.inputInstructions).toBeNull();
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	},
);
