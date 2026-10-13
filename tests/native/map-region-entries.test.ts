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

const fixture = "tests/local/map-region-entries.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-map-region-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("region-local Map entries", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves aliases, numeric keys, missing entries, structural mutations, and overrides under %s primordials",
		(primordials) => {
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, MAL_MAP_MUTABLE: primordials },
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `map-region-${primordials}`,
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
					(fn) => fn.storage!.mapEntries.length > 0,
				),
			).toBe(true);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", MAL_MAP_MUTABLE: primordials, ...stress },
							timeoutMs: 60_000,
						}),
					).toBe(expected);
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60_000,
				env: {
					...process.env,
					MAL_HOST_GC: "1",
					MAL_MAP_MUTABLE: primordials,
					MAL_PERF_STATS: "1",
				},
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(expected);
			const stats = measured.stderr.match(
				/\[perf-map-region-stats\] hits=(\d+) misses=(\d+)/,
			);
			expect(stats).not.toBeNull();
			expect(Number(stats![1])).toBeGreaterThan(0);
			expect(Number(stats![2])).toBeGreaterThan(0);
		},
		600_000,
	);
});
