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

const fixture = "tests/local/fixed-typed-array-region.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-fixed-typed-array-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("fixed TypedArray storage regions", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves numeric conversions, mixed overlap, fallback coercions, detachment, and polled state under %s primordials",
		(primordials) => {
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: process.env,
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `fixed-typed-array-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(
				pair.programImage.native.functions
					.flatMap((fn) => fn.storage!.numericLoopRegions)
					.some((plan) => plan.kind === "fixed-numeric"),
			).toBe(true);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", ...stress },
							timeoutMs: 60_000,
						}),
					).toBe(expected);
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60_000,
				env: {
					...process.env,
					MAL_HOST_GC: "1",
					MAL_PERF_STATS: "1",
				},
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(expected);
			const stats = measured.stderr.match(
				/\[perf-typed-array-region-stats\] admissions=(\d+) i32_views=(\d+) u32_views=(\d+) f32_views=(\d+) f64_views=(\d+) f64_regions=(\d+) i8_views=(\d+) u8_views=(\d+) u8c_views=(\d+) i16_views=(\d+) u16_views=(\d+) affine_regions=(\d+)/,
			);
			expect(stats).not.toBeNull();
			for (const count of stats!.slice(1)) expect(Number(count)).toBeGreaterThan(0);
			expect(Number(stats![6])).toBeLessThan(Number(stats![1]));
		},
		600_000,
	);
});
