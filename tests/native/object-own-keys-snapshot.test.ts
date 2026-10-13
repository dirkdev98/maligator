import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	runToStdout,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/object-own-keys-snapshot.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-own-keys-snapshot-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("own string and Symbol key snapshots", () => {
	it("materializes an Array in the captured builtin realm", () => {
		const realmFixture = "tests/local/object-own-keys-realms.js";
		const expected = execFileSync(
			process.execPath,
			[
				"--expose-gc",
				"-e",
				`globalThis.$262={gc:globalThis.gc,createRealm(){return {global:require("node:vm").runInNewContext("globalThis")};}};require(${JSON.stringify(resolve(realmFixture))});`,
			],
			{ encoding: "utf8", timeout: 15000 },
		);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture: realmFixture,
				name: `own-key-realms-${compiled}`,
				compiled,
				outDir,
				mainFile: "runtime/test262_main.c",
				config: resolveBuildConfig({
					engine: { primordials: "mutable", realms: true, eval: false },
				}),
			});
			for (const kind of ["names", "symbols"])
				expect(
					built.programImage.native.functions.some((fn) =>
						fn.storage!.objectEnumerationSnapshots.some((plan) => plan.kind === kind),
					),
					kind,
				).toBe(true);
			expect(
				runToStdout(built.binaryPath, {
					env: { MAL_TEST262: "1", MAL_HOST_GC: "1", ...STRESS_ENV },
					timeoutMs: 60000,
				}),
			).toBe(expected);
		}
	}, 600000);
	it.each(["mutable", "locked"] as const)(
		"preserves key order, identity, cached materialization and fallback under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `own-key-snapshot-${primordials}`,
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
						(plan) => plan.kind === kind && plan.elementIps.length > 0,
					),
					name,
				).toBe(true);
			}
			for (const mode of ["names", "symbols", "materialize", "fallback"]) {
				const env = {
					OWN_KEYS_KIND: mode,
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
					const run = spawnSync(invocation.executable, invocation.args, {
						encoding: "utf8",
						timeout: 60000,
						env: { ...process.env, ...env, ...STRESS_ENV },
					});
					const context = `${primordials} ${backend} ${mode}`;
					expect(run.status, `${context}: ${run.stderr}`).toBe(0);
					expect(run.stdout, context).toBe(expected);
					if (backend === "compiled" && mode !== "fallback") {
						for (const kind of mode === "materialize" ? ["names", "symbols"] : [mode]) {
							const stats = run.stderr.match(
								new RegExp(
									`\\[perf-object-${kind}-snapshot-stats\\] admissions=(\\d+) materializations=(\\d+)`,
								),
							);
							expect(stats, `${context}: ${run.stderr}`).not.toBeNull();
							expect(Number(stats![1]), context).toBeGreaterThan(0);
							if (mode === "materialize")
								expect(Number(stats![2]), context).toBeGreaterThan(0);
						}
					}
				}
			}
		},
		600000,
	);
});
