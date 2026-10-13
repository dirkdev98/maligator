import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/string-span-handlers.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-span-handlers-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("string spans beside unrelated exception handlers", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves lifetimes, captures, cached observations, and fallbacks under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				entryGoal: "script",
				entryStrict: false,
				name: `span-handlers-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { primordials, eval: false, realms: false },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const named = (name: string) =>
				pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
			for (const name of [
				"afterSplit",
				"afterRegexp",
				"afterRange",
				"catchRange",
				"disjoint",
			]) {
				expect(named(name).body.handlers.length, name).toBeGreaterThan(0);
				expect(named(name).storage!.spanContinuations.length, name).toBeGreaterThan(0);
			}
			for (const name of ["protectedAlias", "generations"])
				expect(named(name).storage!.spanContinuations, name).toEqual([]);
			for (const kind of [
				"split",
				"regexp",
				"range",
				"catch",
				"disjoint",
				"fallback",
				"protected",
			]) {
				const env = { SPAN_HANDLER_KIND: kind };
				const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
					encoding: "utf8",
					timeout: 10000,
					env: { ...process.env, ...env },
				});
				for (const [backend, target] of [
					["compiled", pair.compiled],
					["interpreted", pair.interpreted],
				] as const) {
					const invocation = resolveHarnessExecutionInvocation(target);
					const run = spawnSync(invocation.executable, invocation.args, {
						encoding: "utf8",
						timeout: 60000,
						env: {
							...process.env,
							...env,
							...STRESS_ENV,
							MAL_HOST_GC: "1",
							MAL_PERF_STATS: "1",
						},
					});
					const context = `${primordials} ${kind} ${backend}`;
					expect(run.status, `${context}: ${run.stderr}`).toBe(0);
					expect(run.stdout, context).toBe(expected);
					if (backend === "compiled" && ["split", "regexp", "disjoint"].includes(kind)) {
						const counts = run.stderr.match(
							/\[perf-string-span-search-source-stats\] range=(\d+) split=(\d+) regexp=(\d+) nested=(\d+)/,
						);
						expect(counts, context).not.toBeNull();
						expect(Number(counts![kind === "regexp" ? 3 : 2]), context).toBeGreaterThan(
							0,
						);
					}
					if (backend === "compiled" && (kind === "range" || kind === "catch")) {
						const nested = run.stderr.match(
							/\[perf-string-span-nested-stats\] admissions=(\d+)/,
						);
						expect(nested, context).not.toBeNull();
						expect(Number(nested![1]), context).toBeGreaterThan(0);
					}
				}
			}
		},
		600000,
	);
});
