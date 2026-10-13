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

const fixture = "tests/local/object-keys-count-region.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-object-keys-count-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("Object.keys count regions", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves enumerable own key counts, proxy observations, and builtin overrides under %s primordials",
		(primordials) => {
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, MAL_PRIMORDIALS: primordials },
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `object-keys-count-${primordials}`,
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
					(fn) => fn.storage!.objectKeysSnapshots.length > 0,
				),
			).toBe(true);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", MAL_PRIMORDIALS: primordials, ...stress },
							timeoutMs: 60_000,
						}),
					).toBe(expected);
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60_000,
				env: {
					...process.env,
					MAL_HOST_GC: "1",
					MAL_PRIMORDIALS: primordials,
					MAL_PERF_STATS: "1",
				},
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(expected);
			const stats = measured.stderr.match(
				/\[perf-object-keys-count-stats\] admissions=(\d+)/,
			);
			expect(stats).not.toBeNull();
			expect(Number(stats![1])).toBeGreaterThan(0);
			const snapshots = measured.stderr.match(
				/\[perf-object-keys-snapshot-stats\] admissions=(\d+) materializations=(\d+)/,
			);
			expect(snapshots).not.toBeNull();
			expect(Number(snapshots![1])).toBeGreaterThan(0);
			expect(Number(snapshots![2])).toBeGreaterThan(0);
		},
		600_000,
	);
});
