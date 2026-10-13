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

const fixture = "tests/local/array-initialization-incremental.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-incremental-array-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("incremental fresh Array initialization", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves collecting initializers, abrupt order and inherited setters under %s primordials",
		(primordials) => {
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
				env: { ...process.env, MAL_PRIMORDIALS: primordials },
				timeout: 30000,
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `incremental-array-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const [name, length] of [
				["effectful", 9],
				["large64", 64],
				["large128", 128],
			] as const) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(
					fn.storage!.arrayInitializations.some(
						(plan) => plan.mode === "incremental" && plan.values.length === length,
					),
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
						/\[perf-array-initialization-stats\] regions=(\d+) large_regions=(\d+) incremental_regions=(\d+)/,
					);
					expect(stats, run.stderr).not.toBeNull();
					expect(Number(stats![3]), context).toBeGreaterThanOrEqual(40);
				}
			}
		},
		600000,
	);
});
