import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	runToStdout,
	resolveHarnessExecutionInvocation,
	HOST_MAIN,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/string-span-locale-compare.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-span-locale-compare-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("Locale comparison from rooted string spans", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves bounded collation, coercion ordering and prepared cache calls under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `span-locale-compare-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false, intl: { enabled: true } },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const name of ["range", "split", "capture", "nested"]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				const kinds = [
					...fn.specializations.flatMap((p) =>
						p.kind === "string-span" ? p.consumers : [],
					),
					...fn.storage!.spanContinuations.flatMap((p) => p.consumers),
				].map((c) => c.kind);
				expect(kinds, `${primordials} ${name}`).toEqual(
					expect.arrayContaining(["localeCompareCall"]),
				);
			}
			if (primordials === "locked")
				for (const name of ["prepared", "preparedSplit", "preparedCapture"]) {
					const fn = pair.programImage.native.functions.find(
						(fn) =>
							String.fromCharCode(
								...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
									[]),
							) === name,
					)!;
					const consumers = [
						...fn.specializations.flatMap((p) =>
							p.kind === "string-span" ? p.consumers : [],
						),
						...fn.storage!.spanContinuations.flatMap((p) => p.consumers),
					];
					expect(
						consumers.map((c) => c.kind),
						name,
					).toContain("localeComparePrepared");
				}

			for (const mode of [
				"range",
				"split",
				"regexp",
				"nested",
				"fallback",
				"prepared",
				"bounded",
			]) {
				const env = {
					SPAN_LOCALE_COMPARE_MODE: mode,
					SPAN_LOCALE_COMPARE_PRIMORDIALS: primordials,
					MAL_HOST_GC: "1",
				};
				const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
					encoding: "utf8",
					timeout: 10000,
					env: { ...process.env, ...env },
				});
				for (const [backend, target] of [
					["compiled", pair.compiled],
					["interpreted", pair.interpreted],
				] as const) {
					const context = `${primordials} ${mode} ${backend}`;
					const invocation = resolveHarnessExecutionInvocation(target);
					const result = spawnSync(invocation.executable, [...invocation.args], {
						encoding: "utf8",
						timeout: 60000,
						env: { ...process.env, ...env, ...STRESS_ENV, MAL_PERF_STATS: "1" },
					});
					expect(result.status, `${context}: ${result.error ?? result.stderr}`).toBe(0);
					expect(result.stdout, context).toBe(expected);
					if (backend !== "compiled" || mode === "fallback") continue;
					const counts = result.stderr.match(
						/\[perf-string-span-locale-compare-stats\] calls=(\d+) prepared=(\d+)/,
					);
					expect(counts, `${context}: ${result.stderr}`).not.toBeNull();
					const index = mode === "prepared" && primordials === "locked" ? 2 : 1;
					expect(Number(counts![index]), `${context}: ${counts![0]}`).toBeGreaterThan(0);
					if (mode === "prepared" && primordials === "locked")
						expect(
							Number(
								result.stderr.match(/\[perf-intl-collation-stats\] hits=(\d+)/)?.[1] ?? 0,
							),
							context,
						).toBeGreaterThan(0);
					if (mode === "bounded")
						expect(
							Number(result.stderr.match(/flatten_code_units=(\d+)/)?.[1] ?? Infinity),
							context,
						).toBeLessThan(16384);
				}
			}
		},
		600000,
	);
	it.each(["mutable", "locked"] as const)(
		"retains UTF16 comparison when Intl is disabled under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `span-locale-compare-disabled-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false, intl: { enabled: false } },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const [backend, target] of [
				["compiled", pair.compiled],
				["interpreted", pair.interpreted],
			] as const) {
				const invocation = resolveHarnessExecutionInvocation(target);
				const result = spawnSync(invocation.executable, invocation.args, {
					encoding: "utf8",
					timeout: 60000,
					env: {
						...process.env,
						...STRESS_ENV,
						SPAN_LOCALE_COMPARE_MODE: "disabled",
						MAL_HOST_GC: "1",
						MAL_PERF_STATS: "1",
					},
				});
				expect(result.status, `${primordials} ${backend}: ${result.stderr}`).toBe(0);
				expect(result.stdout).toBe('["disabled PASS"]\n');
				if (backend === "compiled")
					expect(
						Number(
							result.stderr.match(
								/\[perf-string-span-locale-compare-stats\] calls=(\d+)/,
							)?.[1] ?? 0,
						),
					).toBeGreaterThan(0);
			}
		},
		600000,
	);

	it("preserves foreign locale-compare methods, error realms and captured callees", () => {
		const fixture = "tests/local/string-span-locale-compare-realms.js";
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
				name: `span-locale-compare-realms-${compiled}`,
				compiled,
				outDir,
				mainFile: "runtime/test262_main.c",
				config: resolveBuildConfig({
					engine: {
						primordials: "mutable",
						eval: false,
						realms: true,
						intl: { enabled: true },
					},
				}),
			});
			expect(
				runToStdout(built.binaryPath, {
					env: { ...STRESS_ENV, MAL_TEST262: "1", MAL_HOST_GC: "1" },
					timeoutMs: 60000,
				}),
				`foreign locale compare compiled=${compiled}`,
			).toBe(expected);
		}
	}, 600000);
});
