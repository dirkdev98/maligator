import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-mutable-primordial-regions-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

/** Builds a fixture with mutable primordials and checks both backends against Node. */
function describeMutableRegions(
	name: string,
	title: string,
	admitted: (stderr: string, loops: number) => void,
): void {
	const fixture = `tests/local/${name}.mjs`;
	describe(title, () => {
		let compiled: string;
		let interpreted: string;
		let expected: string;
		beforeAll(() => {
			({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
				fixture,
				name,
				outDir,
				config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			}));
			expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		});

		for (const mode of ["compiled", "interpreted"] as const) {
			it(`observes every replacement in ${mode} mode`, () => {
				const binary = mode === "compiled" ? compiled : interpreted;
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
			});
		}

		it("runs the warm loops as specialized regions while the primordials are intact", () => {
			const invocation = resolveHarnessExecutionInvocation(compiled);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: { ...process.env, MAL_PERF_STATS: "1" },
				encoding: "utf8",
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe(expected);
			admitted(result.stderr, Number(result.stdout.match(/\bloops=(\d+)/)?.[1]));
		});
	});
}

describeMutableRegions(
	"mutable-region-math",
	"numeric loops calling Math through a mutable global",
	(stderr, loops) => {
		const admissions = Number(
			stderr.match(/\[perf-loop-invariant-stats\] .*builtin-call-admissions=(\d+)/)?.[1],
		);
		// Each warm-up round runs four loops that call a Math builtin.
		expect(admissions).toBeGreaterThanOrEqual(4 * loops);
	},
);

describeMutableRegions(
	"mutable-region-typed-kinds",
	"typed array loops over views from mutable global constructors",
	(stderr, loops) => {
		const admissions = Number(
			stderr.match(/\[perf-typed-array-region-stats\] .*expected_regions=(\d+)/)?.[1],
		);
		// Each warm-up round fills and then reads a Uint32Array and a Float64Array.
		expect(admissions).toBeGreaterThanOrEqual(2 * loops);
	},
);

describeMutableRegions(
	"mutable-region-record-columns",
	"record loops over Array.from results through mutable globals",
	(stderr) => {
		const admissions = Number(
			stderr.match(/\[perf-call-cache-stats\] .*record_columns_admissions=(\d+)/)?.[1],
		);
		// The intact and restored runs each pack their records once.
		expect(admissions).toBeGreaterThanOrEqual(2);
	},
);
