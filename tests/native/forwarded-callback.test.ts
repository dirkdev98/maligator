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

const fixture = "tests/local/forwarded-callback.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-forwarded-callback-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("runtime nomination of forwarded callbacks", () => {
	it.each(["mutable", "locked"] as const)(
		"resolves ordinary closures once and preserves boxed invocation with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				entryGoal: "script",
				entryStrict: false,
				name: `forwarded-callback-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { primordials, eval: false, realms: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const image = pair.programImage;
			for (const [name, operation] of [
				["forwardEach", "Collection.prototype.forEach"],
				["forwardMap", "ArrayOrTypedArray.prototype.map"],
				["forwardReduce", "ArrayOrTypedArray.prototype.reduce"],
				["forwardRight", "ArrayOrTypedArray.prototype.reduceRight"],
			]) {
				const fn = image.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
						) === name,
				)!;
				expect(fn, name).toBeDefined();
				const call = fn.instructions.find(
					(plan) =>
						plan?.kind === "call" && plan.guardedBuiltinCall?.operation === operation,
				);
				expect(call, name).toBeDefined();
				if (call?.kind !== "call") throw new Error("missing forwarded call");
				expect(call.directCallbackFunctionIndex, name).toBeUndefined();
				expect(fn.storage!.callbackTransports, name).toEqual([]);
			}
			for (const kind of ["array", "typed", "map", "set", "reentry", "fallbacks"]) {
				const env = { FORWARDED_CALLBACK_KIND: kind, MAL_HOST_GC: "1" };
				const expected = execFileSync(
					process.execPath,
					[
						"--expose-gc",
						"-e",
						`require("node:vm").runInThisContext(require("node:fs").readFileSync(${JSON.stringify(fixture)}, "utf8"), { filename: ${JSON.stringify(fixture)} });`,
					],
					{
						encoding: "utf8",
						env: { ...process.env, ...env },
					},
				);
				const measured = spawnSync(pair.compiled, [], {
					encoding: "utf8",
					timeout: 60000,
					env: { ...process.env, ...env, MAL_PERF_STATS: "1" },
				});
				expect(measured.status, measured.stderr).toBe(0);
				expect(measured.stdout).toBe(expected);
				const counter = (name: string) =>
					Number(measured.stderr.match(new RegExp(`${name}=(\\d+)`))?.[1] ?? 0);
				if (kind === "fallbacks")
					expect(counter("iteration_runtime_callback_nominations")).toBe(0);
				else {
					expect(counter("iteration_runtime_callback_nominations"), kind).toBeGreaterThan(
						0,
					);
					expect(
						counter("iteration_exact_compiled_callback_calls"),
						kind,
					).toBeGreaterThan(0);
				}
				expect(counter("iteration_numeric_reduce_calls"), kind).toBe(0);
				expect(counter("iteration_typed_callback_hits"), kind).toBe(0);
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(
						runToStdout(binary, { env: { ...env, ...STRESS_ENV }, timeoutMs: 60000 }),
					).toBe(expected);
				}
			}
		},
		600000,
	);
	it("keeps foreign callbacks and borrowed methods on the realm-aware fallback", () => {
		const realmFixture = "tests/local/forwarded-callback-realms.js";
		const expected = execFileSync(
			process.execPath,
			[
				"--expose-gc",
				"-e",
				`globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")};}};require(${JSON.stringify(join(process.cwd(), realmFixture))});`,
			],
			{ encoding: "utf8" },
		);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture: realmFixture,
				name: `forwarded-realms-${compiled}`,
				compiled,
				mainFile: "runtime/test262_main.c",
				outDir,
				config: resolveBuildConfig({
					engine: { primordials: "mutable", realms: true, eval: true },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(
				runToStdout(built.binaryPath, {
					env: { MAL_TEST262: "1", MAL_HOST_GC: "1", ...STRESS_ENV },
					timeoutMs: 60000,
				}),
			).toBe(expected);
		}
	}, 600000);
});
