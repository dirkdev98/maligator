import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const outDir = mkdtempSync(join(tmpdir(), "mal-set-algebra-callback-"));
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
	target: string,
	expected: string,
	nominations: number,
	env: NodeJS.ProcessEnv,
	context: string,
) {
	const invocation = resolveHarnessExecutionInvocation(target);
	const run = spawnSync(invocation.executable, invocation.args, {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, ...env, ...STRESS_ENV, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" },
	});
	expect(run.status, `${context}: ${run.stderr}`).toBe(0);
	expect(run.stdout, context).toBe(expected);
	const counter = run.stderr.match(
		/\[perf-set-algebra-callback-stats\] has_nominations=(\d+)/,
	);
	expect(counter, `${context}: ${run.stderr}`).not.toBeNull();
	expect(Number(counter![1]), context).toBe(nominations);
	if (nominations > 0)
		expect(
			Number(run.stderr.match(/iteration_exact_compiled_callback_calls=(\d+)/)?.[1] ?? 0),
			context,
		).toBeGreaterThan(0);
}
describe("captured Set algebra has callback contracts", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves acquisition and per-method traversal under %s primordials",
		(primordials) => {
			const fixture = "tests/local/set-algebra-callback.js";
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				entryGoal: "script",
				entryStrict: false,
				name: `set-algebra-callback-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { primordials, eval: false, realms: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const [kind, nominations] of [
				["intersection", 1],
				["difference", 1],
				["isSubsetOf", 1],
				["isDisjointFrom", 1],
				["keys", 0],
				["values", 1],
				["abrupt", 4],
				["acquisition", 0],
				["fallbacks", 0],
				["outer", 0],
			] as const) {
				const env = { SET_ALGEBRA_KIND: kind };
				const expected = oracle(fixture, env);
				for (const [backend, target] of [
					["compiled", pair.compiled],
					["interpreted", pair.interpreted],
				] as const)
					observe(
						target,
						expected,
						backend === "compiled" ? nominations : 0,
						env,
						`${primordials} ${kind} ${backend}`,
					);
			}
		},
		600_000,
	);
	it("preserves borrowed builtin result realms and custom/native callback error realms", () => {
		const fixture = "tests/local/set-algebra-callback-realms.js";
		const expected = oracle(fixture, {}, true);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture,
				entryGoal: "script",
				entryStrict: false,
				compiled,
				name: `set-algebra-callback-realms-${compiled}`,
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
				compiled ? 2 : 0,
				{ MAL_TEST262: "1" },
				`realms compiled=${compiled}`,
			);
		}
	}, 600_000);
});
