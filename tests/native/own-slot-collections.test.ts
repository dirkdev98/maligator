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
const fixture = "tests/local/own-slot-collections.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-own-slot-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("named own-field regions over collection receivers", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves collection named fields, internal properties and collecting fallbacks with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `own-slot-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const names = (kind: "propertyReadRegions" | "numberRecordRegions") =>
				pair.programImage.native.functions
					.filter((fn) => fn.storage?.[kind].length)
					.map((fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						),
					);
			expect(names("propertyReadRegions")).toEqual(
				expect.arrayContaining(["references", "extent"]),
			);
			expect(names("numberRecordRegions")).toContain("sum");
			for (const mode of [
				"array",
				"typed",
				"map",
				"set",
				"mixed",
				"dictionary",
				"fallback",
			]) {
				const env = {
					OWN_SLOT_MODE: mode,
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
						if (mode !== "dictionary" && mode !== "fallback") {
							expect(Number(stats![2]), context).toBeGreaterThan(0);
							const numeric = Number(
								result.stderr.match(
									/\[perf-number-record\] attempts=\d+ admissions=(\d+)/,
								)?.[1] ?? 0,
							);
							expect(numeric, context).toBeGreaterThan(0);
						}
						expect(Number(stats![3]), context).toBeGreaterThan(0);
					}
				}
			}
		},
		600000,
	);
});
