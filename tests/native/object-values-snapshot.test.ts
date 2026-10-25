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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-object-values-snapshot-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("Object enumeration snapshots", () => {
	it.each(
		(["mutable", "locked"] as const).flatMap((primordials) =>
			["values-snapshot", "enumeration-handlers"].map((kind) => ({
				primordials,
				kind,
				fixture: `tests/local/object-${kind}.js`,
			})),
		),
	)(
		"preserves eager values, roots, fallback effects and materialized observers in $kind under $primordials primordials",
		({ primordials, kind, fixture }) => {
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, MAL_PRIMORDIALS: primordials },
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `object-${kind}-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			if (kind === "values-snapshot") {
				const callback = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === "valuesSnapshotIndex",
				)!;
				expect(
					callback.storage!.objectEnumerationSnapshots.some(
						(plan) => plan.kind === "values" && plan.elementIps.length > 0,
					),
				).toBe(true);
				expect(
					pair.programImage.native.functions.some((fn) =>
						fn.storage!.objectEnumerationSnapshots.some(
							(plan) => plan.kind === "values" && plan.elementIps.length === 0,
						),
					),
				).toBe(true);
				const surviving = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === "survivingValueIndex",
				)!;
				expect(surviving.storage!.objectEnumerationSnapshots).toEqual([]);
				const entry = surviving.directEntries.find(
					(e) => e.parameterRepresentations[1] === "string",
				)!;
				expect(entry).toBeDefined();
				expect(entry.storage!.objectEnumerationSnapshots).toHaveLength(1);
				expect(
					entry.storage!.objectEnumerationSnapshots[0]!.elementIps.length,
				).toBeGreaterThan(0);
			} else {
				for (const [name, family] of [
					["keysAfterHandler", "keys"],
					["valuesAfterHandler", "values"],
					["keysInCatch", "keys"],
					["valuesInCatch", "values"],
				]) {
					const fn = pair.programImage.native.functions.find(
						(fn) =>
							String.fromCharCode(
								...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
									[]),
							) === name,
					)!;
					expect(fn.body.handlers.length, name).toBeGreaterThan(0);
					expect(
						fn.storage!.objectEnumerationSnapshots.some(
							(plan) => plan.kind === family && plan.elementIps.length > 0,
						),
						name,
					).toBe(true);
				}
			}
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", MAL_PRIMORDIALS: primordials, ...stress },
							timeoutMs: 60000,
						}),
					).toBe(expected);
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60000,
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
				/\[perf-object-values-snapshot-stats\] admissions=(\d+) materializations=(\d+)/,
			);
			expect(stats).not.toBeNull();
			expect(Number(stats![1])).toBeGreaterThan(0);
			expect(Number(stats![2])).toBeGreaterThan(0);
			if (kind === "enumeration-handlers") {
				const keys = measured.stderr.match(
					/\[perf-object-keys-snapshot-stats\] admissions=(\d+) materializations=(\d+)/,
				)!;
				expect(keys).not.toBeNull();
				for (const counts of [stats!, keys]) {
					expect(Number(counts[1])).toBeGreaterThanOrEqual(16);
					expect(Number(counts[2])).toBeGreaterThanOrEqual(8);
				}
			}
		},
		600000,
	);
});
