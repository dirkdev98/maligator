import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/string-span-parsers.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-span-parsers-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("numeric parsers over rooted string spans", () => {
	it("preserves foreign parser realms and captured callees across coercion", () => {
		const fixture = "tests/local/string-span-parsers-realms.js";
		const expected = execFileSync(
			process.execPath,
			[
				"--expose-gc",
				"-e",
				`globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")}}};require(${JSON.stringify(resolve(fixture))});`,
			],
			{ encoding: "utf8" },
		);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture,
				name: `span-parser-realms-${compiled}`,
				compiled,
				outDir,
				mainFile: "runtime/test262_main.c",
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: false, realms: true },
				}),
			});
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(built.binaryPath, {
						env: { MAL_TEST262: "1", MAL_HOST_GC: "1", ...stress },
						timeoutMs: 60000,
					}),
				).toBe(expected);
		}
	}, 600000);

	it.each(["mutable", "locked"] as const)(
		"preserves parsing, coercion order, fallback and GC under %s primordials",
		(primordials) => {
			const env = { MAL_HOST_GC: "1", MAL_SPAN_MUTABLE: primordials };
			const oracle = (extra = {}) =>
				execFileSync(process.execPath, ["--expose-gc", fixture], {
					encoding: "utf8",
					env: { ...process.env, ...env, ...extra },
				});
			const expected = oracle();
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `span-parsers-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const name of [
				"parseRange",
				"parseSplit",
				"parseCapture",
				"parseNested",
				"parseBounded",
			]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				const kinds = [
					...fn.specializations.flatMap((r) =>
						r.kind === "string-span" ? r.consumers : [],
					),
					...fn.storage!.spanContinuations.flatMap((p) => p.consumers),
				].map((c) => c.kind);
				expect(kinds, name).toEqual(expect.arrayContaining(["parseInt", "parseFloat"]));
			}
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, { env: { ...env, ...stress }, timeoutMs: 60000 }),
					).toBe(expected);
			for (const [index, family] of ["range", "split", "regexp", "nested"].entries()) {
				const extra = { MAL_SPAN_PARSE_FAMILY: family };
				const result = spawnSync(pair.compiled, [], {
					encoding: "utf8",
					timeout: 60000,
					env: { ...process.env, ...env, ...extra, MAL_PERF_STATS: "1" },
				});
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout).toBe(oracle(extra));
				const parsers = result.stderr.match(
					/\[perf-string-span-parse-stats\] parse_int=(\d+) parse_float=(\d+)/,
				);
				expect(parsers, family).not.toBeNull();
				for (const count of parsers!.slice(1))
					expect(Number(count), `${family}: ${parsers![0]}`).toBeGreaterThan(0);
				const sources = result.stderr.match(
					/\[perf-string-span-parse-source-stats\] range=(\d+) split=(\d+) regexp=(\d+) nested=(\d+)/,
				);
				expect(sources, family).not.toBeNull();
				expect(Number(sources![index + 1]), `${family}: ${sources![0]}`).toBeGreaterThan(
					0,
				);
			}
		},
		600000,
	);
});
