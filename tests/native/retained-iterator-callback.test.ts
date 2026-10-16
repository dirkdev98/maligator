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

const fixture = "tests/local/retained-iterator-callback.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-retained-iterator-callback-"));
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

describe("retained lazy Iterator callback contracts", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves retained captures, abrupt completion and roots under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				entryGoal: "script",
				entryStrict: false,
				name: `retained-iterator-callback-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { primordials, eval: false, realms: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const forward = pair.programImage.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "forwardLazy",
			)!;
			expect(forward).toBeDefined();
			expect(forward.storage!.callbackTransports).toEqual([]);
			expect(forward.body.instructions.some((op) => op.opcode === "CALL")).toBe(true);
			for (const kind of [
				"map",
				"filter",
				"flatMap",
				"abrupt",
				"reentry",
				"roots",
				"fallbacks",
			]) {
				const env = { ITERATOR_LAZY_KIND: kind, MAL_HOST_GC: "1" };
				// Node24 lacks Iterator.concat; this mode asserts the native concat/GC contract itself.
				const expected = kind === "roots" ? "roots retained\n" : nodeOracle(fixture, env);
				const measured = spawnSync(pair.compiled, [], {
					encoding: "utf8",
					timeout: 60_000,
					env: { ...process.env, ...env, MAL_PERF_STATS: "1" },
				});
				expect(measured.status, `${primordials} ${kind}: ${measured.stderr}`).toBe(0);
				expect(measured.stdout).toBe(expected);
				const counters = measured.stderr.match(
					/\[perf-iterator-lazy-callback-stats\] nominations=(\d+) resumes=(\d+)/,
				);
				expect(counters, measured.stderr).not.toBeNull();
				const counts = counters!.slice(1).map(Number);
				if (kind === "fallbacks") expect(counts).toEqual([0, 0]);
				else {
					expect(counts[0]).toBeGreaterThan(0);
					expect(counts[1]).toBeGreaterThan(0);
					if (["map", "filter", "flatMap"].includes(kind)) {
						expect(counts[0]).toBe(1);
						expect(counts[1]).toBeGreaterThan(1);
					}
				}
				for (const [backend, binary] of [
					["compiled", pair.compiled],
					["interpreted", pair.interpreted],
				] as const) {
					const context = `retained-iterator ${primordials} ${kind} ${backend} GC stress`;
					try {
						expect(
							runToStdout(binary, { env: { ...env, ...STRESS_ENV }, timeoutMs: 60_000 }),
							context,
						).toBe(expected);
					} catch (cause) {
						process.stderr.write(`[native] ${context} failed\n`);
						throw new Error(context, { cause });
					}
				}
			}
		},
		600_000,
	);
	it("rebuilds the canonical entry after an outer typed context expires", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "retained-iterator-typed-context",
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
						transport.argumentCount === 3 &&
						transport.parameters[1] === "number",
				),
		).toBe(true);
		const env = { ITERATOR_LAZY_KIND: "arity", MAL_HOST_GC: "1" };
		const expected = nodeOracle(fixture, env);
		const measured = spawnSync(pair.compiled, [], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, ...env, ...STRESS_ENV, MAL_PERF_STATS: "1" },
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
		expect(
			Number(
				measured.stderr.match(
					/\[perf-iterator-lazy-callback-stats\] nominations=\d+ resumes=(\d+)/,
				)?.[1] ?? 0,
			),
		).toBeGreaterThan(0);
		expect(
			runToStdout(pair.interpreted, {
				env: { ...env, ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
		).toBe(expected);
	}, 600_000);
	it("retains owned cross-realm callbacks while eval callbacks remain generic", () => {
		const realmFixture = "tests/local/retained-iterator-callback-realms.js";
		const expected = nodeOracle(realmFixture, {}, true);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture: realmFixture,
				entryGoal: "script",
				entryStrict: false,
				name: `retained-iterator-realms-${compiled}`,
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
			const nominations = measured.stderr.match(
				/\[perf-iterator-lazy-callback-stats\] nominations=(\d+) resumes=(\d+)/,
			);
			expect(nominations, measured.stderr).not.toBeNull();
			expect(nominations!.slice(1).map(Number)).toEqual(compiled ? [1, 3] : [0, 0]);
			expect(
				Number(
					measured.stderr.match(
						/\[perf-callback-realm-stats\] foreign_nominations=(\d+)/,
					)?.[1] ?? -1,
				),
			).toBe(compiled ? 1 : 0);
		}
	}, 600_000);
	it.each([true, false])(
		"uses Number counters and stable IDs across relocation (compiled=%s)",
		(compiled) => {
			const built = buildNativeBinaryResult({
				fixture: "tests/local/iterator-callback-boundaries.js",
				mainFile: "tests/fixtures/iterator-callback-boundaries/main.c",
				name: `iterator-callback-boundaries-${compiled}`,
				compiled,
				outDir,
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: false, realms: false },
				}),
			});
			expect(runToStdout(built.binaryPath, { env: STRESS_ENV, timeoutMs: 60_000 })).toBe(
				"iterator-callback-boundaries PASS\n",
			);
		},
		600_000,
	);
});
