import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/object-entries-snapshot.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-object-entries-snapshot-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("Object.entries snapshots", () => {
	it("uses the captured builtin realm for both the outer Array and each pair", () => {
		const realmFixture = "tests/local/object-entries-snapshot-realms.js";
		const expected = execFileSync(
			process.execPath,
			[
				"-e",
				`globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")};}};require(${JSON.stringify(resolve(realmFixture))});`,
			],
			{ encoding: "utf8" },
		);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture: realmFixture,
				name: `object-entries-realms-${compiled}`,
				compiled,
				outDir,
				mainFile: "runtime/test262_main.c",
				config: resolveBuildConfig({ engine: { primordials: "mutable", realms: true } }),
			});
			expect(
				built.programImage.native.functions.some((fn) =>
					fn.storage!.objectEnumerationSnapshots.some((plan) => plan.kind === "entries"),
				),
			).toBe(true);
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(built.binaryPath, {
						env: { MAL_TEST262: "1", MAL_HOST_GC: "1", ...stress },
					}),
				).toBe(expected);
		}
	}, 600000);

	it.each(["mutable", "locked"] as const)(
		"preserves eager data and cached pair/outer identity under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `object-entries-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const name of [
				"entriesCount",
				"entriesIndex",
				"entriesMaterialize",
				"entriesRead",
			]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(
					fn.storage!.objectEnumerationSnapshots.some((plan) => plan.kind === "entries"),
					name,
				).toBe(true);
			}
			for (const mode of ["count", "index", "materialize", "semantics"]) {
				const env = {
					MAL_PRIMORDIALS: primordials,
					ENTRIES_CASE: mode,
					MAL_HOST_GC: "1",
				};
				const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
					encoding: "utf8",
					env: { ...process.env, ...env },
				});
				for (const binary of [pair.compiled, pair.interpreted])
					for (const stress of [{}, STRESS_ENV])
						expect(
							runToStdout(binary, { env: { ...env, ...stress }, timeoutMs: 60000 }),
						).toBe(expected);
				const measured = spawnSync(pair.compiled, [], {
					encoding: "utf8",
					timeout: 60000,
					env: { ...process.env, ...env, MAL_PERF_STATS: "1" },
				});
				expect(measured.status, measured.stderr).toBe(0);
				expect(measured.stdout).toBe(expected);
				const stats = measured.stderr.match(
					/\[perf-object-entries-snapshot-stats\] admissions=(\d+) materializations=(\d+) pair_materializations=(\d+)/,
				)!;
				expect(stats, mode).not.toBeNull();
				const admissions = Number(stats[1]),
					outer = Number(stats[2]),
					pairs = Number(stats[3]);
				expect(admissions, mode).toBeGreaterThan(0);
				if (mode === "count") {
					expect(outer).toBe(0);
					expect(pairs).toBe(0);
				} else if (mode === "index") {
					expect(outer).toBe(0);
					expect(pairs).toBe(admissions);
				} else if (mode === "materialize") {
					expect(outer).toBe(admissions);
					expect(pairs).toBe(admissions * 8);
				} else {
					expect(outer).toBeGreaterThan(0);
					expect(pairs).toBeGreaterThan(0);
				}
			}
		},
		600000,
	);
});
