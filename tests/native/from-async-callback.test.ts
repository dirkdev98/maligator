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
const outDir = mkdtempSync(join(tmpdir(), "mal-from-async-callback-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
function oracle(fixture: string, env: NodeJS.ProcessEnv, realms = false) {
	const output = execFileSync(
		process.execPath,
		[
			"--expose-gc",
			"-e",
			`${realms ? 'globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")}}};' : ""}require("node:vm").runInThisContext(require("node:fs").readFileSync(${JSON.stringify(fixture)},"utf8"));`,
		],
		{ encoding: "utf8", timeout: 10_000, env: { ...process.env, ...env } },
	);
	expect(output.trim()).not.toBe("");
	expect(output).not.toContain("FAIL");
	return output;
}
function observe(
	target: string,
	expected: string,
	counts: readonly [number, number],
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
		/\[perf-array-from-async-callback-stats\] nominations=(\d+) resumes=(\d+)/,
	);
	expect(counter, `${context}: ${run.stderr}`).not.toBeNull();
	expect(counter!.slice(1).map(Number), context).toEqual(counts);
	if (counts[1] > 0)
		expect(
			Number(run.stderr.match(/iteration_exact_compiled_callback_calls=(\d+)/)?.[1] ?? 0),
			context,
		).toBeGreaterThan(0);
}
describe("retained Array.fromAsync callback contracts", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves mapper state across awaits and setup collection under %s primordials",
		(primordials) => {
			const fixture = "tests/local/from-async-callback.js";
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				entryGoal: "script",
				entryStrict: false,
				name: `from-async-callback-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { primordials, eval: false, realms: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const [kind, nominations, resumes] of [
				["sync", 1, 3],
				["async", 1, 2],
				["arrayLike", 1, 3],
				["reentry", 2, 4],
				["abrupt", 3, 2],
				["freshErrors", 3, 3],
				["closeOrder", 3, 3],
				["closeAbrupt", 8, 7],
				["proxyResult", 1, 2],
				["acquisition", 3, 0],
				["fallbacks", 0, 0],
			] as const) {
				const env = { FROM_ASYNC_KIND: kind };
				// GetIteratorFromMethod reads next once; Node 26 reads twice on the sync path.
				// AsyncIteratorClose preserves a mapper rejection even when return throws; Node 26 leaves it pending.
				const expected =
					kind === "sync"
						? "sync 10 14 18 async,sync,next-get,construct,next0,map0,await0,next1,map1,await1,next2,map2,await2,next3\n"
						: kind === "abrupt"
							? "abrupt 2\n"
							: kind === "closeAbrupt"
								? "closeAbrupt 6 3 1\n"
								: kind === "closeOrder"
									? "closeOrder 3\n"
									: oracle(fixture, env);
				for (const [backend, target] of [
					["compiled", pair.compiled],
					["interpreted", pair.interpreted],
				] as const)
					observe(
						target,
						expected,
						backend === "compiled" ? [nominations, resumes] : [0, 0],
						env,
						`${primordials} ${kind} ${backend}`,
					);
			}
		},
		600_000,
	);
	it("retains owned foreign mapper identity across awaits and runtime compilation", () => {
		const fixture = "tests/local/from-async-callback-realms.js";
		const expected = oracle(fixture, {}, true);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture,
				entryGoal: "script",
				entryStrict: false,
				compiled,
				name: `from-async-callback-realms-${compiled}`,
				outDir,
				mainFile: "runtime/test262_main.c",
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: true, realms: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			observe(
				built.binaryPath,
				expected,
				compiled ? [1, 3] : [0, 0],
				{ MAL_TEST262: "1", MAL_EVAL_GC_STRESS_INTERVAL: "1000" },
				`realms compiled=${compiled}`,
			);
		}
	}, 600_000);
	it.each([true, false])(
		"uses Number indices, proxy definitions, and an awaited safe-index close (compiled=%s)",
		(compiled) => {
			const built = buildNativeBinaryResult({
				fixture: "tests/local/from-async-boundaries.js",
				mainFile: "tests/fixtures/from-async-boundaries/main.c",
				entryGoal: "script",
				entryStrict: false,
				name: `from-async-boundaries-${compiled}`,
				compiled,
				outDir,
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: false, realms: false },
				}),
			});
			const invocation = resolveHarnessExecutionInvocation(built.binaryPath);
			const run = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				timeout: 60_000,
				env: { ...process.env, ...STRESS_ENV },
			});
			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout).toBe("from-async-boundaries PASS\n");
		},
		600_000,
	);
});
