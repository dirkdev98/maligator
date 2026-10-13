import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const outDir = mkdtempSync(join(tmpdir(), "mal-owned-realm-callback-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
// Program callbacks keep every-safepoint stress; only runtime compilation uses its own cadence.
const callbackStressEnv = { ...STRESS_ENV, MAL_EVAL_GC_STRESS_INTERVAL: "1000" };
describe("VM-owned foreign callback realms", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves callback and builtin realms under %s primordials",
		(primordials) => {
			const fixture = "tests/local/owned-realm-callback.js";
			const expected = execFileSync(
				process.execPath,
				[
					"--expose-gc",
					"-e",
					`globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")}}};require("node:vm").runInThisContext(require("node:fs").readFileSync(${JSON.stringify(fixture)},"utf8"));`,
				],
				{ encoding: "utf8" },
			);
			for (const compiled of [true, false]) {
				const built = buildNativeBinaryResult({
					fixture,
					entryGoal: "script",
					entryStrict: false,
					name: `owned-realm-callback-${primordials}-${compiled}`,
					compiled,
					outDir,
					mainFile: "runtime/test262_main.c",
					config: resolveBuildConfig({
						engine: { primordials, eval: true, realms: true },
					}),
					environment: { ...process.env, MAL_PERF_STATS: "1" },
				});
				const measured = spawnSync(built.binaryPath, [], {
					encoding: "utf8",
					timeout: 60_000,
					env: {
						...process.env,
						MAL_TEST262: "1",
						MAL_HOST_GC: "1",
						MAL_PERF_STATS: "1",
						...callbackStressEnv,
					},
				});
				expect(
					measured.status,
					`${primordials} compiled=${compiled}: ${measured.stderr}`,
				).toBe(0);
				expect(measured.stdout).toBe(expected);
				expect(
					Number(
						measured.stderr.match(
							/\[perf-callback-realm-stats\] foreign_nominations=(\d+)/,
						)?.[1] ?? -1,
					),
				).toBe(compiled ? 8 : 0);
				const lazy = measured.stderr.match(
					/\[perf-iterator-lazy-callback-stats\] nominations=(\d+) resumes=(\d+)/,
				);
				expect(lazy, measured.stderr).not.toBeNull();
				expect(lazy!.slice(1).map(Number)).toEqual(compiled ? [1, 3] : [0, 0]);
			}
		},
		600_000,
	);
	it("rejects same-index closures from another VM and executes owned second-realm compiled closures", () => {
		const built = buildNativeBinaryResult({
			fixture: "tests/local/owned-realm-callback-boundaries.js",
			entryGoal: "script",
			entryStrict: false,
			mainFile: "tests/fixtures/owned-realm-callback/main.c",
			name: "owned-realm-callback-boundaries",
			compiled: true,
			outDir,
			config: resolveBuildConfig({
				engine: { primordials: "mutable", eval: false, realms: true },
			}),
		});
		expect(
			runToStdout(built.binaryPath, {
				env: { ...STRESS_ENV, MAL_HOST_GC: "1" },
				timeoutMs: 60_000,
			}),
		).toBe("owned-realm-callback PASS\n");
	}, 600_000);
});
