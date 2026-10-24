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
		"retains strided interleaved windows, overlap and exact overshoot with %s primordials",
		(primordials) => {
			const strideFixture = "tests/local/fixed-typed-array-stride.js";
			const pair = buildBackendPairFromOneProgramImage({
				fixture: strideFixture,
				name: `fixed-stride-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const [name, stride] of [
				["threeLanes", 3],
				["fourLanes", 4],
				["overshoot", 2147483647],
			] as const) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(
					fn?.storage!.numericLoopRegions.some(
						(plan) => plan.kind === "fixed-numeric" && plan.counter?.stride === stride,
					),
					name,
				).toBe(true);
			}
			for (const mode of ["three", "four", "edges", "overshoot"]) {
				const env = { TYPED_STRIDE_KIND: mode, MAL_HOST_GC: "1" };
				const expected = execFileSync(process.execPath, [strideFixture], {
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
							/\[perf-typed-array-stride-stats\] admissions=(\d+)/,
						)?.[1] ?? 0,
					),
					mode,
				).toBeGreaterThan(0);
				for (const binary of [pair.compiled, pair.interpreted])
					expect(
						runToStdout(binary, { env: { ...env, ...STRESS_ENV }, timeoutMs: 60000 }),
					).toBe(expected);
			}
		},
		600000,
	);
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
			const checkedRegions = (name: string) =>
				(
					pair.programImage.native.functions.find(
						(fn) =>
							String.fromCharCode(
								...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
									[]),
							) === name,
					)?.storage?.numericLoopRegions ?? []
				).filter(
					(plan) =>
						plan.kind === "fixed-numeric" &&
						plan.views.some((view) => view.checked === true),
				).length;
			expect(checkedRegions("readThenBump")).toBeGreaterThan(0);
			expect(checkedRegions("propagateKinds")).toBeGreaterThan(0);
			for (const name of ["unionRoots", "windowSums", "settle", "tableMix"])
				expect(checkedRegions(name), name).toBeGreaterThan(0);
			expect(checkedRegions("bumpThenRead")).toBe(0);
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
