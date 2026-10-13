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

const outDir = mkdtempSync(join(tmpdir(), "mal-from-entries-pairs-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
function oracle(fixture: string, env: NodeJS.ProcessEnv, realms = false) {
	return execFileSync(
		process.execPath,
		[
			"--expose-gc",
			"-e",
			`${realms ? 'globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")}}};' : ""}require("node:vm").runInThisContext(require("node:fs").readFileSync(${JSON.stringify(fixture)},"utf8"));`,
		],
		{ encoding: "utf8", env: { ...process.env, ...env } },
	);
}
function observe(
	binary: string,
	expected: string,
	count: number,
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
	const counter = run.stderr.match(
		/\[perf-object-from-entries-stats\] borrowed_pairs=(\d+)/,
	);
	expect(counter, `${context}: ${run.stderr}`).not.toBeNull();
	expect(Number(counter![1]), context).toBe(count);
}
describe("Object.fromEntries borrowed entry pairs", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves live cursor, coercion and abrupt behavior under %s primordials",
		(primordials) => {
			const fixture = "tests/local/from-entries-borrowed-pairs.js";
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				entryGoal: "script",
				entryStrict: false,
				name: `from-entries-pairs-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { primordials, eval: false, realms: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const [kind, count] of [
				["map", 3],
				["set", 3],
				["array", 5],
				["mutation", 6],
				["abrupt", 1],
				["fallbacks", 0],
			] as const) {
				const env = { FROM_ENTRIES_KIND: kind };
				// IteratorStepValue abrupt completion never closes; Node incorrectly closes this case.
				const expected = kind === "abrupt" ? "abrupt 1 1\n" : oracle(fixture, env);
				for (const [backend, binary] of [
					["compiled", pair.compiled],
					["interpreted", pair.interpreted],
				] as const)
					observe(binary, expected, count, env, `${primordials} ${kind} ${backend}`);
			}
		},
		600_000,
	);
	it("retains result realms with foreign iterators and borrowed builtin methods", () => {
		const fixture = "tests/local/from-entries-borrowed-pairs-realms.js";
		const expected = oracle(fixture, {}, true);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture,
				entryGoal: "script",
				entryStrict: false,
				name: `from-entries-pairs-realms-${compiled}`,
				compiled,
				outDir,
				mainFile: "runtime/test262_main.c",
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: false, realms: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			observe(
				built.binaryPath,
				expected,
				4,
				{ MAL_TEST262: "1" },
				`realms compiled=${compiled}`,
			);
		}
	}, 600_000);
});
