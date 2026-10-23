import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/dense-array-number-region.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-dense-array-region-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function regionPlans(
	pair: ReturnType<typeof buildBackendPairFromOneProgramImage>,
	name: string,
) {
	const fn = pair.programImage.native.functions.find(
		(candidate) =>
			String.fromCharCode(
				...(pair.programImage.runtime.stringConstants[candidate.body.nameStringIndex] ??
					[]),
			) === name,
	);
	return fn?.storage?.numericLoopRegions ?? [];
}

describe("dense Array number loop regions", () => {
	it.each(["mutable", "locked"] as const)(
		"sums reloaded and hoisted Array lengths unboxed and declines other elements with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `dense-array-region-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(
				regionPlans(pair, "sumReloaded").some(
					(plan) => plan.kind === "fixed-numeric" && plan.boundObject !== undefined,
				),
			).toBe(true);
			expect(
				regionPlans(pair, "sumHoisted").some((plan) => plan.kind === "fixed-numeric"),
			).toBe(true);
			for (const name of ["lookupSum", "recordLookup"])
				expect(
					regionPlans(pair, name).some(
						(plan) =>
							plan.kind === "fixed-numeric" &&
							plan.views.some((view) => view.checked === true),
					),
					name,
				).toBe(true);
			for (const name of ["sumOf", "centroidOf", "destructuredCentroidOf"])
				expect(
					regionPlans(pair, name).some((plan) => plan.kind === "array-iteration"),
					name,
				).toBe(true);
			expect(
				regionPlans(pair, "centroid").some(
					(plan) => plan.kind === "fixed-numeric" && (plan.records?.length ?? 0) > 0,
				),
			).toBe(true);
			const env = {
				MAL_HOST_GC: "1",
				DENSE_ARRAY_PROTOTYPE_HOLE: primordials === "mutable" ? "1" : "0",
			};
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60000,
				env: { ...process.env, ...env, MAL_PERF_STATS: "1" },
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(expected);
			expect(
				Number(
					measured.stderr.match(
						/\[perf-dense-array-region-stats\] admissions=(\d+)/,
					)?.[1] ?? 0,
				),
			).toBeGreaterThan(0);
			for (const binary of [pair.compiled, pair.interpreted])
				expect(
					runToStdout(binary, { env: { ...env, ...STRESS_ENV }, timeoutMs: 60000 }),
				).toBe(expected);
		},
		600000,
	);
});
