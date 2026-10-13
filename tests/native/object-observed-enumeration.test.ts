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
const fixture = "tests/local/object-observed-enumeration.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-observed-enumeration-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("Accessor-backed enumeration snapshots", () => {
	it("retains getter results, pair identity and captured builtin realms", () => {
		const realmFixture = "tests/local/object-observed-enumeration-realms.js";
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
				name: `observed-enumeration-realms-${compiled}`,
				compiled,
				outDir,
				mainFile: "runtime/test262_main.c",
				config: resolveBuildConfig({
					engine: { primordials: "mutable", realms: true, eval: false },
				}),
			});
			for (const kind of ["values", "entries"])
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
		"preserves getter order, mutations, throws, reentry and GC under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `observed-enumeration-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const kind of ["values", "entries"] as const) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === kind,
				)!;
				expect(
					fn.storage!.objectEnumerationSnapshots.some(
						(plan) => plan.kind === kind && plan.elementIps.length > 0,
					),
					kind,
				).toBe(true);
			}
			for (const mode of ["values", "entries", "throw", "reentry", "fallback"]) {
				const env = {
					OBSERVED_ENUM_MODE: mode,
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
					if (backend === "compiled") {
						const stats = run.stderr.match(
							/\[perf-enumeration-observed-stats\] values=(\d+) entries=(\d+)/,
						);
						expect(stats, `${context}: ${run.stderr}`).not.toBeNull();
						if (mode === "fallback")
							expect(Number(stats![1]) + Number(stats![2]), context).toBe(0);
						else
							for (const index of mode === "values"
								? [1]
								: mode === "entries"
									? [2]
									: [1, 2])
								expect(Number(stats![index]), context).toBeGreaterThan(0);
					}
				}
			}
		},
		600000,
	);
});
