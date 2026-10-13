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
const fixture = "tests/local/string-span-normalize.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-span-normalize-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("Unicode normalization output from rooted string spans", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves bounded normalization, form coercion, ignored argument effects and fallback under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `span-normalize-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
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
					expect.arrayContaining(["normalizeCall"]),
				);
			}
			for (const mode of ["range", "split", "regexp", "nested", "fallback"]) {
				const env = {
					SPAN_NORMALIZE_MODE: mode,
					SPAN_NORMALIZE_PRIMORDIALS: primordials,
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
						/\[perf-string-span-normalize-stats\] calls=(\d+)/,
					);
					expect(counts, `${context}: ${result.stderr}`).not.toBeNull();
					for (const value of counts!.slice(1))
						expect(Number(value), `${context}: ${counts![0]}`).toBeGreaterThan(0);
				}
			}
		},
		600000,
	);
	it("preserves foreign normalization forms, error realms and captured callees", () => {
		const fixture = "tests/local/string-span-normalize-realms.js";
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
				name: `span-normalize-realms-${compiled}`,
				compiled,
				outDir,
				mainFile: "runtime/test262_main.c",
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: false, realms: true },
				}),
			});
			expect(
				runToStdout(built.binaryPath, {
					env: { ...STRESS_ENV, MAL_TEST262: "1", MAL_HOST_GC: "1" },
					timeoutMs: 60000,
				}),
				`foreign normalization compiled=${compiled}`,
			).toBe(expected);
		}
	}, 600000);
});
