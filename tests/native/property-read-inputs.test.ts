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

const fixture = "tests/local/property-read-inputs.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-property-inputs-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("property-read input and branch regions", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves typeof, truthiness, wide reference reads and fallback order under %s primordials",
		(primordials) => {
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
				env: { ...process.env, MAL_PRIMORDIALS: primordials },
				timeout: 30000,
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `property-inputs-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const [name, length] of [
				["inspectNested", 8],
				["readWide", 16],
			] as const) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(
					fn.storage!.propertyReadRegions.some((plan) => plan.loads.length === length),
					name,
				).toBe(true);
			}
			for (const [backend, target] of [
				["compiled", pair.compiled],
				["interpreted", pair.interpreted],
			] as const) {
				const invocation = resolveHarnessExecutionInvocation(target);
				const run = spawnSync(invocation.executable, invocation.args, {
					encoding: "utf8",
					timeout: 60000,
					env: {
						...process.env,
						MAL_PRIMORDIALS: primordials,
						MAL_HOST_GC: "1",
						MAL_PERF_STATS: "1",
						...STRESS_ENV,
					},
				});
				const context = `${primordials} ${backend}`;
				expect(run.status, `${context}: ${run.stderr}`).toBe(0);
				expect(run.stdout, context).toBe(expected);
				if (backend === "compiled") {
					const stats = run.stderr.match(
						/\[perf-property-read-region-stats\] admissions=(\d+) hits=(\d+) continuations=(\d+)/,
					);
					expect(stats, run.stderr).not.toBeNull();
					expect(Number(stats![2]), context).toBeGreaterThan(100);
					expect(Number(stats![3]), context).toBeGreaterThan(0);
				}
			}
		},
		600000,
	);
});
