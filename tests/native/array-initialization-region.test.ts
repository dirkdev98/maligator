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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-initialization-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("fresh Array initialization", () => {
	it.each(
		(["mutable", "locked"] as const).flatMap((primordials) =>
			["region", "handlers"].map((kind) => ({
				primordials,
				kind,
				fixture: `tests/local/array-initialization-${kind}.js`,
			})),
		),
	)(
		"preserves prepared values, roots, and effects in $kind under $primordials primordials",
		({ primordials, kind, fixture }) => {
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, MAL_ARRAY_MUTABLE: primordials },
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `array-initialization-${kind}-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(
				pair.programImage.native.functions.some(
					(fn) => fn.storage!.arrayInitializations.length > 0,
				),
			).toBe(true);
			const expectedPlans =
				kind === "handlers"
					? ([
							["afterHandler", 9],
							["catchValues", 9],
						] as const)
					: ([
							["numeric", 5],
							["mixedLarge", 32],
						] as const);
			for (const [name, length] of expectedPlans) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(
					fn.storage!.arrayInitializations.some((plan) => plan.values.length === length),
					name,
				).toBe(true);
				if (kind === "handlers") expect(fn.body.handlers.length, name).toBeGreaterThan(0);
			}
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", MAL_ARRAY_MUTABLE: primordials, ...stress },
							timeoutMs: 60_000,
						}),
					).toBe(expected);
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60_000,
				env: {
					...process.env,
					MAL_HOST_GC: "1",
					MAL_ARRAY_MUTABLE: primordials,
					MAL_PERF_STATS: "1",
				},
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(expected);
			const stats = measured.stderr.match(
				/\[perf-array-initialization-stats\] regions=(\d+) large_regions=(\d+)/,
			);
			expect(stats).not.toBeNull();
			expect(Number(stats![1])).toBeGreaterThan(0);
			expect(Number(stats![2])).toBeGreaterThan(0);
			if (kind === "handlers") expect(Number(stats![2])).toBeGreaterThanOrEqual(24);
		},
		600_000,
	);
});
