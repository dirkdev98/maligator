import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/known-object-observation.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-known-object-observation-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("known builtin object observations", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves materialized identity, descriptors, freeze, and GC under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `known-object-observation-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const name of [
				"freezeRead",
				"freezeWrite",
				"sealRead",
				"descriptorRead",
				"assignRead",
				"builtinAlias",
				"mixedFreeze",
			]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				const observations = fn.specializations.flatMap((region) =>
					region.kind === "stack-object-plan"
						? region.sites.flatMap((site) =>
								site.materializations.filter((entry) => entry.kind === "observe"),
							)
						: [],
				);
				expect(observations.length, name).toBeGreaterThan(0);
				if (primordials === "locked")
					expect(
						observations.some(
							(entry) => fn.body.instructions[entry.ip]?.opcode === "CALL_KNOWN",
						),
						name,
					).toBe(true);
			}
			for (const mode of ["freezeRead", "semantics"]) {
				const env = {
					MAL_PRIMORDIALS: primordials,
					OBJECT_OBSERVER_CASE: mode,
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
				if (mode === "freezeRead") {
					const measured = spawnSync(pair.compiled, [], {
						encoding: "utf8",
						timeout: 60000,
						env: { ...process.env, ...env, MAL_PERF_STATS: "1" },
					});
					expect(measured.status, measured.stderr).toBe(0);
					expect(measured.stdout).toBe(expected);
					const stats = measured.stderr.match(
						/\[perf-allocation-stats\] empty_objects=\d+ shaped_objects=\d+ stack_objects=(\d+) stack_materializations=(\d+)/,
					)!;
					expect(stats).not.toBeNull();
					const objects = Number(stats[1]),
						materializations = Number(stats[2]);
					expect(objects).toBeGreaterThan(0);
					expect(materializations).toBeGreaterThan(0);
					expect(materializations).toBeLessThan(objects);
				}
			}
		},
		600000,
	);
});
