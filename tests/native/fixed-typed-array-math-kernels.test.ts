import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/fixed-typed-array-math-kernels.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-typed-math-kernels-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("fixed storage across numeric kernels and variadic builtins", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves kernel edge values, variadic coercions and overlapping views with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `typed-math-kernels-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const selected = pair.programImage.native.functions
				.filter((fn) =>
					fn.storage?.numericLoopRegions.some((plan) => plan.kind === "fixed-numeric"),
				)
				.map((fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					),
				)
				.sort();
			expect(selected).toEqual(
				primordials === "locked"
					? ["angle", "half", "integer", "limits", "missing", "norm", "power"]
					: [],
			);
			for (const mode of [
				"integer",
				"half",
				"power",
				"angle",
				"norm",
				"limits",
				"missing",
				"fallback",
			]) {
				const env = {
					TYPED_MATH_KERNEL: mode,
					MAL_PRIMORDIALS: primordials,
					MAL_HOST_GC: "1",
					MAL_PERF_STATS: "1",
				};
				const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
					encoding: "utf8",
					env: { ...process.env, ...env },
					timeout: 15000,
				});
				for (const [backend, target] of [
					["compiled", pair.compiled],
					["interpreted", pair.interpreted],
				] as const) {
					const invocation = resolveHarnessExecutionInvocation(target);
					const run = spawnSync(invocation.executable, invocation.args, {
						encoding: "utf8",
						timeout: 60000,
						env: { ...process.env, ...env, ...STRESS_ENV },
					});
					const context = `${primordials} ${backend} ${mode}`;
					expect(run.status, `${context}: ${run.stderr}`).toBe(0);
					expect(run.stdout, context).toBe(expected);
					if (backend === "compiled") {
						const admissions = Number(
							run.stderr.match(
								/\[perf-typed-array-region-stats\] admissions=(\d+)/,
							)?.[1] ?? 0,
						);
						if (primordials === "locked" && mode !== "fallback")
							expect(admissions, context).toBeGreaterThan(0);
						else if (primordials === "mutable") expect(admissions, context).toBe(0);
					}
				}
			}
		},
		600000,
	);
});
