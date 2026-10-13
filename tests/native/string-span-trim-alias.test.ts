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
const outDir = mkdtempSync(join(tmpdir(), "mal-trim-alias-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
function run(target: string, env: NodeJS.ProcessEnv, context: string) {
	const invocation = resolveHarnessExecutionInvocation(target);
	const result = spawnSync(invocation.executable, [...invocation.args], {
		encoding: "utf8",
		timeout: 60000,
		env: { ...process.env, ...env, ...STRESS_ENV, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" },
	});
	expect(result.status, `${context}: ${result.error ?? result.stderr}`).toBe(0);
	return result;
}
describe("canonical trim aliases and ignored arguments", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves alias identity, argument effects and nested spans under %s primordials",
		(primordials) => {
			const fixture = "tests/local/string-span-trim-alias.js";
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `trim-alias-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const spans = pair.programImage.native.functions.flatMap((fn) => [
				...fn.specializations.filter((p) => p.kind === "string-span"),
				...(fn.storage?.spanContinuations ?? []),
			]);
			expect(spans.map((p) => p.rangeOperation)).toEqual(
				expect.arrayContaining(["trimLeft", "trimRight", "trim"]),
			);
			for (const [name, sourceKind] of [
				["nested", "range"],
				["split", "split"],
				["capture", "regexp"],
			]) {
				const target = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				);
				expect(
					target?.storage?.spanContinuations.some(
						(span) => span.sourceKind === sourceKind,
					),
					`${primordials}: ${name} ${sourceKind} continuation`,
				).toBe(true);
			}
			for (const mode of [
				"left",
				"right",
				"many",
				"range",
				"split",
				"regexp",
				"fallback",
			]) {
				const env = { TRIM_ALIAS_MODE: mode, TRIM_ALIAS_PRIMORDIALS: primordials };
				const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
					encoding: "utf8",
					timeout: 10000,
					env: { ...process.env, ...env },
				});
				for (const [backend, binary] of [
					["compiled", pair.compiled],
					["interpreted", pair.interpreted],
				] as const) {
					const context = `${primordials} ${mode} ${backend}`,
						result = run(binary, env, context);
					expect(result.stdout, context).toBe(expected);
					if (backend !== "compiled" || mode === "fallback") continue;
					const counts = result.stderr.match(
						/\[perf-string-span-trim-stats\] trim=(\d+) trim_start=(\d+) trim_end=(\d+)/,
					);
					expect(counts, `${context}: ${result.stderr}`).not.toBeNull();
					for (const index of mode === "left"
						? [2]
						: mode === "right"
							? [3]
							: mode === "many"
								? [1]
								: [2, 3])
						expect(Number(counts![index]), context).toBeGreaterThan(0);
					if (mode === "range" || mode === "split" || mode === "regexp") {
						const sources = result.stderr.match(
							/\[perf-string-span-trim-source-stats\] direct=(\d+) range=(\d+) split=(\d+) regexp=(\d+)/,
						);
						expect(sources, `${context}: ${result.stderr}`).not.toBeNull();
						const index = mode === "range" ? 2 : mode === "split" ? 3 : 4;
						expect(
							Number(sources![index]),
							`${context}: ${mode} source ${sources![0]}`,
						).toBeGreaterThan(0);
					}
				}
			}
		},
		600000,
	);
	it("preserves foreign aliases during boxed coercion and receiver throws", () => {
		const fixture = "tests/local/string-span-trim-realms.js";
		const expected = execFileSync(
			process.execPath,
			[
				"--expose-gc",
				"-e",
				`globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")}}};require("node:vm").runInThisContext(require("node:fs").readFileSync(${JSON.stringify(fixture)},"utf8"));`,
			],
			{ encoding: "utf8", timeout: 10000 },
		);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture,
				name: `trim-alias-realms-${compiled}`,
				compiled,
				outDir,
				mainFile: "runtime/test262_main.c",
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: false, realms: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(
				run(built.binaryPath, { MAL_TEST262: "1" }, `realms compiled=${compiled}`).stdout,
			).toBe(expected);
		}
	}, 600000);
});
