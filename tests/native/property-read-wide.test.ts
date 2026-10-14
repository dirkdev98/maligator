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
const fixture = "tests/local/property-read-wide.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-property-wide-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("wide property regions over ordinary and callable own slots", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves wide references and collecting continuations with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `property-wide-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const fn = pair.programImage.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "readWide",
			)!;
			expect(fn.storage!.propertyReadRegions.map((plan) => plan.loads.length)).toEqual([
				32, 8,
			]);
			for (const mode of [
				"object",
				"frozen",
				"prototype",
				"function",
				"bound",
				"native",
				"polymorphic",
				"inherited",
				"fallback",
			]) {
				const env = {
					PROPERTY_WIDE_MODE: mode,
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
					const result = spawnSync(invocation.executable, invocation.args, {
						encoding: "utf8",
						timeout: 60000,
						env: { ...process.env, ...env, ...STRESS_ENV },
					});
					const context = `${primordials} ${backend} ${mode}`;
					expect(result.status, `${context}: ${result.stderr}`).toBe(0);
					expect(result.stdout, context).toBe(expected);
					if (backend === "compiled") {
						const stats = result.stderr.match(
							/\[perf-property-read-region-stats\] admissions=(\d+) hits=(\d+) continuations=(\d+) poly=(\d+)/,
						);
						expect(stats, context).not.toBeNull();
						if (mode !== "inherited")
							expect(Number(stats![2]), context).toBeGreaterThan(100);
						if (mode === "fallback" || mode === "inherited")
							expect(Number(stats![3]), context).toBeGreaterThan(0);
						if (mode === "polymorphic")
							expect(Number(stats![4]), context).toBeGreaterThan(100);
					}
				}
			}
		},
		600000,
	);
});
