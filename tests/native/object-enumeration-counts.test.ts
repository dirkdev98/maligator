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
const fixture = "tests/local/object-enumeration-counts.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-enumeration-counts-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("count-only enumeration across unbounded record and Array sizes", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves captured counts, accessor effects and fallback under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `enumeration-counts-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const [name, kind] of [
				["names", "names"],
				["symbols", "symbols"],
				["keys", "keys"],
				["values", "values"],
				["entries", "entries"],
			] as const) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(
					fn.storage!.objectEnumerationSnapshots.some(
						(plan) => plan.kind === kind && plan.elementIps.length === 0,
					),
					name,
				).toBe(true);
			}
			for (const mode of [
				"keys",
				"values",
				"entries",
				"names",
				"symbols",
				"primitive",
				"effects",
			]) {
				const env = { ENUM_COUNT_KIND: mode, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" };
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
					if (backend === "compiled" && mode !== "effects") {
						for (const family of mode === "primitive"
							? ["keys", "values", "entries", "names", "symbols"]
							: [mode]) {
							const stats = run.stderr.match(
								new RegExp(`\\[perf-object-${family}-count-stats\\] admissions=(\\d+)`),
							);
							expect(stats, `${context}: ${run.stderr}`).not.toBeNull();
							expect(Number(stats![1]), context).toBeGreaterThanOrEqual(12);
							const snapshot = run.stderr.match(
								new RegExp(
									`\\[perf-object-${family}-snapshot-stats\\] admissions=(\\d+)`,
								),
							);
							expect(snapshot, `${context}: ${run.stderr}`).not.toBeNull();
							expect(Number(snapshot![1]), context).toBe(0);
						}
					}
				}
			}
		},
		600000,
	);
});
