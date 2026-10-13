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

const fixture = "tests/local/collection-foreach-callback.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-collection-callback-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("Map and Set exact callback invocation", () => {
	it.each(["mutable", "locked"] as const)(
		"carries shared forEach invocations through helper parameters and loop backedges with %s primordials",
		(primordials) => {
			const familyFixture = "tests/local/collection-foreach-family.js";
			const pair = buildBackendPairFromOneProgramImage({
				fixture: familyFixture,
				name: `collection-family-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { primordials, eval: false, realms: false },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const image = pair.programImage;
			const callback = image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "familyVisit",
			)!;
			expect(callback).toBeDefined();
			const owner = image.native.functions.find((fn) =>
				fn.storage!.callbackTransports.some(
					(plan) => plan.functionIndex === callback.functionIndex,
				),
			)!;
			const transport = owner.storage!.callbackTransports.find(
				(plan) => plan.functionIndex === callback.functionIndex,
			)!;
			expect(transport.parameters).toEqual(["number", "number", "boxed"]);
			expect(owner.instructions[transport.instructionIp]).toMatchObject({
				guardedBuiltinCall: { operation: "Collection.prototype.forEach" },
			});
			for (const kind of ["map", "set", "array", "typed", "array-object", "controls"]) {
				const env = { COLLECTION_FAMILY_KIND: kind, MAL_HOST_GC: "1" };
				const expected = execFileSync(process.execPath, [familyFixture], {
					encoding: "utf8",
					env: { ...process.env, ...env },
				});
				for (const binary of [pair.compiled, pair.interpreted])
					for (const stress of [{}, STRESS_ENV])
						expect(
							runToStdout(binary, { env: { ...env, ...stress }, timeoutMs: 60000 }),
						).toBe(expected);
				const measured = spawnSync(pair.compiled, [], {
					encoding: "utf8",
					timeout: 60000,
					env: { ...process.env, ...env, MAL_PERF_STATS: "1" },
				});
				expect(measured.status, measured.stderr).toBe(0);
				expect(measured.stdout).toBe(expected);
				const counter = (name: string) =>
					Number(measured.stderr.match(new RegExp(`${name}=(\\d+)`))?.[1] ?? 0);
				expect(counter("iteration_exact_compiled_callback_calls"), kind).toBeGreaterThan(
					0,
				);
				if (kind === "array" || kind === "typed" || kind === "array-object")
					expect(counter("iteration_typed_callback_hits"), kind).toBeGreaterThan(0);
				else
					expect(counter("iteration_typed_callback_fallbacks"), kind).toBeGreaterThan(0);
				if (kind === "controls")
					expect(counter("iteration_direct_fallbacks")).toBeGreaterThan(0);
			}
		},
		600000,
	);
	it.each(["mutable", "locked"] as const)(
		"preserves live iteration and boxed arguments with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `collection-callback-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { primordials, eval: false, realms: false },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const selected = pair.programImage.native.functions.flatMap((fn) =>
				fn.instructions.flatMap((plan) =>
					plan?.kind === "call" && plan.directCallbackFunctionIndex !== undefined
						? [plan.guardedBuiltinCall?.operation]
						: [],
				),
			);
			expect(selected).toContain(
				primordials === "locked"
					? "Map.prototype.forEach"
					: "Collection.prototype.forEach",
			);
			expect(selected).toContain(
				primordials === "locked"
					? "Set.prototype.forEach"
					: "Collection.prototype.forEach",
			);
			for (const kind of ["map", "set"]) {
				const env = {
					COLLECTION_CALLBACK_KIND: kind,
					COLLECTION_MUTABLE: primordials === "mutable" ? "1" : "0",
					MAL_HOST_GC: "1",
				};
				const expected = execFileSync(process.execPath, [fixture], {
					encoding: "utf8",
					env: { ...process.env, ...env },
				});
				for (const binary of [pair.compiled, pair.interpreted])
					for (const stress of [{}, STRESS_ENV])
						expect(
							runToStdout(binary, { env: { ...env, ...stress }, timeoutMs: 60000 }),
						).toBe(expected);
				const measured = spawnSync(pair.compiled, [], {
					encoding: "utf8",
					timeout: 60000,
					env: { ...process.env, ...env, COLLECTION_MUTABLE: "0", MAL_PERF_STATS: "1" },
				});
				expect(measured.status, measured.stderr).toBe(0);
				expect(measured.stdout).toBe(expected);
				for (const counter of [
					"iteration_exact_callback_calls",
					"iteration_exact_compiled_callback_calls",
				])
					expect(
						Number(measured.stderr.match(new RegExp(`${counter}=(\\d+)`))?.[1] ?? 0),
						`${kind}: ${counter}`,
					).toBeGreaterThan(0);
			}
		},
		600000,
	);
	it("preserves borrowed method realms and sloppy callback boxing", () => {
		const realmFixture = "tests/local/collection-foreach-realms.js";
		const expected = execFileSync(
			process.execPath,
			[
				"-e",
				`globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")};}};require(${JSON.stringify(join(process.cwd(), "tests/local/collection-foreach-realms.js"))});`,
			],
			{ encoding: "utf8" },
		);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture: realmFixture,
				name: `collection-realms-${compiled}`,
				compiled,
				mainFile: "runtime/test262_main.c",
				outDir,
				config: resolveBuildConfig({
					engine: { primordials: "mutable", realms: true, eval: true },
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
});
