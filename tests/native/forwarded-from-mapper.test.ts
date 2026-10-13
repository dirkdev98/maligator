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
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/forwarded-from-mapper.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-forwarded-from-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
function nodeOracle(path: string, env: NodeJS.ProcessEnv = {}, realms = false) {
	return execFileSync(
		process.execPath,
		[
			"-e",
			`${realms ? 'globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")};}};' : ""}require("node:vm").runInThisContext(require("node:fs").readFileSync(${JSON.stringify(path)},"utf8"),{filename:${JSON.stringify(path)}});`,
		],
		{ encoding: "utf8", env: { ...process.env, ...env } },
	);
}

describe("forwarded from mapper nomination", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves iterator, constructor, conversion and callback ordering under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				entryGoal: "script",
				entryStrict: false,
				name: `forwarded-from-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { primordials, eval: true, realms: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			for (const name of ["forwardArray", "forwardTyped"]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(fn, name).toBeDefined();
				expect(fn.body.instructions.some((op) => op.opcode === "CALL")).toBe(true);
				expect(fn.storage!.callbackTransports).toEqual([]);
			}
			for (const kind of [
				"array-iter",
				"array-like",
				"typed-iter",
				"typed-like",
				"reentry",
				"fallbacks",
			]) {
				const env = { FROM_KIND: kind, MAL_HOST_GC: "1" };
				const expected = nodeOracle(fixture, env);
				const measured = spawnSync(pair.compiled, [], {
					encoding: "utf8",
					timeout: 60_000,
					env: { ...process.env, ...env, MAL_PERF_STATS: "1" },
				});
				expect(measured.status, `${kind} compiled: ${measured.stderr}`).toBe(0);
				expect(measured.stdout).toBe(expected);
				const counters = measured.stderr.match(
					/\[perf-from-callback-stats\] array_nominations=(\d+) typed_nominations=(\d+)/,
				);
				expect(counters, measured.stderr).not.toBeNull();
				const array = Number(counters![1]);
				const typed = Number(counters![2]);
				if (kind === "fallbacks") expect([array, typed]).toEqual([0, 0]);
				else {
					if (kind.startsWith("array-")) {
						expect(array).toBeGreaterThan(0);
						expect(typed).toBe(0);
					}
					if (kind.startsWith("typed-")) {
						expect(typed).toBeGreaterThan(0);
						expect(array).toBe(0);
					}
					if (kind === "reentry") {
						expect(array).toBeGreaterThan(0);
						expect(typed).toBeGreaterThan(0);
					}
					expect(
						Number(
							measured.stderr.match(
								/iteration_exact_compiled_callback_calls=(\d+)/,
							)?.[1] ?? 0,
						),
					).toBeGreaterThan(0);
				}
				for (const [backend, binary] of [
					["compiled", pair.compiled],
					["interpreted", pair.interpreted],
				] as const) {
					const context = `forwarded-from ${primordials} ${kind} ${backend} GC stress`;
					try {
						expect(
							runToStdout(binary, { env: { ...env, ...STRESS_ENV }, timeoutMs: 60_000 }),
							context,
						).toBe(expected);
					} catch (cause) {
						process.stderr.write(`[native] ${context} failed\n`);
						throw new Error(`${context} failed`, { cause });
					}
				}
			}
		},
		600_000,
	);

	it("falls back from a matching outer typed callback when the mapper receives only two arguments", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "forwarded-from-typed-context",
			outDir,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({
				surface: { node: true },
				engine: { primordials: "locked", eval: false, realms: true },
			}),
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		const shared = pair.programImage.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "shared",
		)!;
		expect(shared).toBeDefined();
		expect(
			pair.programImage.native.functions
				.flatMap((fn) => fn.storage!.callbackTransports)
				.some(
					(transport) =>
						transport.functionIndex === shared.functionIndex &&
						transport.parameters[1] === "number" &&
						transport.argumentCount === 3,
				),
		).toBe(true);
		const env = { FROM_KIND: "arity", MAL_HOST_GC: "1" };
		const expected = nodeOracle(fixture, env);
		const measured = spawnSync(pair.compiled, [], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, ...env, MAL_PERF_STATS: "1", ...STRESS_ENV },
		});
		expect(measured.status, measured.stderr).toBe(0);
		expect(measured.stdout).toBe(expected);
		for (const name of [
			"iteration_typed_callback_hits",
			"iteration_typed_callback_fallbacks",
		])
			expect(
				Number(measured.stderr.match(new RegExp(`${name}=(\\d+)`))?.[1] ?? 0),
				name,
			).toBeGreaterThan(0);
		expect(measured.stderr).toMatch(
			/\[perf-from-callback-stats\] array_nominations=0 typed_nominations=0/,
		);
		expect(
			runToStdout(pair.interpreted, {
				env: { ...env, ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
		).toBe(expected);
	}, 600_000);

	it("declines foreign callbacks and preserves local callback realms under borrowed methods", () => {
		const realmFixture = "tests/local/forwarded-from-realms.js";
		const expected = nodeOracle(realmFixture, {}, true);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture: realmFixture,
				entryGoal: "script",
				entryStrict: false,
				name: `forwarded-from-realms-${compiled}`,
				compiled,
				outDir,
				mainFile: "runtime/test262_main.c",
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: true, realms: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const measured = spawnSync(built.binaryPath, [], {
				encoding: "utf8",
				timeout: 60_000,
				env: {
					...process.env,
					MAL_TEST262: "1",
					MAL_HOST_GC: "1",
					MAL_PERF_STATS: "1",
					...STRESS_ENV,
				},
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(expected);
			expect(measured.stderr).toMatch(
				/\[perf-from-callback-stats\] array_nominations=0 typed_nominations=0/,
			);
		}
	}, 600_000);
});
