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
const outDir = mkdtempSync(join(tmpdir(), "mal-span-identity-"));
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
describe("String identity ranges and ignored arguments", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves primitive identity, argument effects and nested spans under %s primordials",
		(primordials) => {
			const fixture = "tests/local/string-span-identity.js";
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `span-identity-${primordials}`,
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
				expect.arrayContaining(["toString", "valueOf"]),
			);
			for (const [name, sourceKind] of [
				["range", "range"],
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
				"toString",
				"valueOf",
				"range",
				"split",
				"regexp",
				"fallback",
			]) {
				const env = { SPAN_IDENTITY_MODE: mode, SPAN_IDENTITY_PRIMORDIALS: primordials };
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
						/\[perf-string-span-identity-stats\] to_string=(\d+) value_of=(\d+)/,
					);
					expect(counts, `${context}: ${result.stderr}`).not.toBeNull();
					for (const index of mode === "toString"
						? [1]
						: mode === "valueOf"
							? [2]
							: [1, 2])
						expect(Number(counts![index]), context).toBeGreaterThan(0);
					if (mode === "range" || mode === "split" || mode === "regexp") {
						const deep = Number(
							result.stderr.match(
								/\[perf-string-span-deep-stats\] admissions=(\d+)/,
							)?.[1] ?? 0,
						);
						expect(
							deep,
							`${context}: complete parent-to-identity-to-identity composition`,
						).toBeGreaterThan(0);
					}
				}
			}
		},
		600000,
	);
	it("preserves foreign identity methods and wrapper versus incompatible receiver brands", () => {
		const fixture = "tests/local/string-span-identity-realms.js";
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
				name: `span-identity-realms-${compiled}`,
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
