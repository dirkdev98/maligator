import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/fixed-typed-array-directions.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-typed-directions-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("directed TypedArray storage regions", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves descending and inclusive ranges, aliasing and fallback under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `typed-directions-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const [name, count] of [
				["reverse", 1],
				["reverseExclusive", 2],
				["inclusive", 2],
				["reverseStride", 2],
				["inclusiveStride", 1],
				["reverseWide", 1],
			] as const) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(
					fn.storage!.numericLoopRegions.some(
						(plan) => plan.kind === "fixed-numeric" && plan.views.length === count,
					),
					name,
				).toBe(true);
			}
			for (const mode of ["reverse", "inclusive", "stride", "fallback"]) {
				const env = { MAL_HOST_GC: "1", TYPED_DIRECTION_KIND: mode };
				const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
					encoding: "utf8",
					env: { ...process.env, ...env },
				});
				for (const target of [pair.compiled, pair.interpreted])
					expect(
						runToStdout(target, { env: { ...env, ...STRESS_ENV }, timeoutMs: 60000 }),
					).toBe(expected);
				const run = spawnSync(pair.compiled, [], {
					encoding: "utf8",
					timeout: 60000,
					env: { ...process.env, ...env, MAL_PERF_STATS: "1" },
				});
				expect(run.status, run.stderr).toBe(0);
				expect(run.stdout).toBe(expected);
				const count = Number(
					run.stderr.match(/\[perf-typed-array-region-stats\] admissions=(\d+)/)?.[1] ??
						-1,
				);
				if (mode !== "fallback") expect(count).toBeGreaterThan(0);
			}
		},
		600000,
	);
});
