import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	resolveHarnessExecutionInvocation,
	HOST_MAIN,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-collection-constructors-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
function oracle(fixture: string, env: NodeJS.ProcessEnv, realms = false) {
	return execFileSync(
		process.execPath,
		[
			"--expose-gc",
			"-e",
			`${realms ? 'globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")}}};' : ""}require("node:vm").runInThisContext(require("node:fs").readFileSync(${JSON.stringify(fixture)},"utf8"));`,
		],
		{ encoding: "utf8", timeout: 10_000, env: { ...process.env, ...env } },
	);
}
function observe(
	binary: string,
	expected: string,
	counters: ReadonlyArray<number>,
	env: NodeJS.ProcessEnv,
	context: string,
) {
	const invocation = resolveHarnessExecutionInvocation(binary);
	const run = spawnSync(invocation.executable, [...invocation.args], {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, ...env, ...STRESS_ENV, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" },
	});
	expect(run.status, `${context}: ${run.error ?? run.stderr}`).toBe(0);
	expect(run.stdout, context).toBe(expected);
	const counts = run.stderr.match(
		/\[perf-collection-constructor-stats\] map=(\d+) weak_map=(\d+) set=(\d+) weak_set=(\d+) borrowed_pairs=(\d+)/,
	);
	expect(counts, `${context}: ${run.stderr}`).not.toBeNull();
	expect(counts!.slice(1).map(Number), context).toEqual(counters);
	if (counters.slice(0, 4).some((count) => count > 0)) {
		expect(
			Number(run.stderr.match(/iteration_exact_compiled_callback_calls=(\d+)/)?.[1] ?? 0),
			context,
		).toBeGreaterThan(0);
	}
}
describe("rooted collection constructor callback contracts", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves acquisition, close and captured adders under %s primordials",
		(primordials) => {
			const fixture = "tests/local/collection-constructor-callback.js";
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				entryGoal: "script",
				entryStrict: false,
				name: `collection-constructors-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { primordials, eval: false, realms: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const [kind, nominations, pairs] of [
				["map", [1, 0, 0, 0], 0],
				["weakMap", [0, 1, 0, 0], 0],
				["set", [0, 0, 1, 0], 0],
				["weakSet", [0, 0, 0, 1], 0],
				["pairs", [1, 0, 0, 0], 10],
				["abrupt", [1, 0, 0, 0], 0],
				["fallbacks", [0, 0, 0, 0], 0],
				["outer", [0, 0, 0, 0], 0],
				["acquisition", [0, 0, 0, 0], 0],
			] as const) {
				const env = { CONSTRUCTOR_KIND: kind };
				const expected = oracle(fixture, env);
				for (const [backend, binary] of [
					["compiled", pair.compiled],
					["interpreted", pair.interpreted],
				] as const) {
					observe(
						binary,
						expected,
						[...nominations.map((count) => (backend === "compiled" ? count : 0)), pairs],
						env,
						`${primordials} ${kind} ${backend}`,
					);
				}
			}
		},
		600_000,
	);
	it.each(["mutable", "locked"] as const)(
		"preserves captured adder and iterator realms under %s primordials",
		(primordials) => {
			const fixture = "tests/local/collection-constructor-realms.js";
			const expected = oracle(fixture, {}, true);
			for (const compiled of [true, false]) {
				const built = buildNativeBinaryResult({
					fixture,
					entryGoal: "script",
					entryStrict: false,
					name: `collection-constructor-realms-${primordials}-${compiled}`,
					compiled,
					outDir,
					mainFile: "runtime/test262_main.c",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: true },
					}),
					environment: { ...process.env, MAL_PERF_STATS: "1" },
				});
				observe(
					built.binaryPath,
					expected,
					[compiled ? 1 : 0, 0, 0, 0, 0],
					{ MAL_TEST262: "1" },
					`realms ${primordials} compiled=${compiled}`,
				);
			}
		},
		600_000,
	);
});
