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
const fixture = "tests/local/fixed-typed-array-reductions.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-typed-reductions-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("read-only and larger TypedArray regions", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves reductions, view bounds, alias order and fallback under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `typed-reductions-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const [name, views, writable] of [
				["sum", 1, false],
				["reverseDot", 2, false],
				["wide", 8, true],
				["lanes", 4, true],
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
						(plan) =>
							plan.kind === "fixed-numeric" &&
							plan.views.length === views &&
							plan.views.some((view) => view.writable) === writable,
					),
					name,
				).toBe(true);
			}
			for (const mode of ["reduce", "wide", "lanes", "fallback", "immutable"]) {
				const env = {
					TYPED_REDUCTION_KIND: mode,
					MAL_PRIMORDIALS: primordials,
					MAL_HOST_GC: "1",
					MAL_PERF_STATS: "1",
				};
				const expected =
					mode === "immutable"
						? '["immutable",["immutable PASS"]]\n'
						: execFileSync(process.execPath, ["--expose-gc", fixture], {
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
					if (backend === "compiled" && mode !== "fallback") {
						const stats = run.stderr.match(
							/\[perf-typed-array-region-stats\] admissions=(\d+)/,
						);
						expect(stats, `${context}: ${run.stderr}`).not.toBeNull();
						expect(Number(stats![1]), context).toBeGreaterThan(0);
					}
				}
			}
		},
		600000,
	);
});
