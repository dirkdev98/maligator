import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/typed-array-callback-families.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-typed-callback-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("TypedArray callback invocation families", () => {
	it.each(["mutable", "locked"] as const)(
		"retains traversal, species, live values, invocation arguments and throws under %s primordials",
		(primordials) => {
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `typed-callback-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const image = pair.programImage;
			const callback = image.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "typedElement",
			)!;
			expect(callback).toBeDefined();
			const selected = image.native.functions.flatMap((fn) =>
				fn
					.storage!.callbackTransports.filter(
						(plan) => plan.functionIndex === callback.functionIndex,
					)
					.map((plan) => {
						expect(plan.argumentCount).toBe(3);
						expect(plan.parameters).toEqual(["number", "number", "boxed"]);
						const call = fn.instructions[plan.instructionIp];
						return call?.kind === "call" ? call.guardedBuiltinCall?.operation : undefined;
					}),
			);
			expect(selected.toSorted()).toEqual(
				[
					"map",
					"filter",
					"forEach",
					"some",
					"every",
					"find",
					"findIndex",
					"findLast",
					"findLastIndex",
				]
					.map((method) =>
						method === "forEach"
							? "Collection.prototype.forEach"
							: `ArrayOrTypedArray.prototype.${method}`,
					)
					.sort(),
			);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", ...stress },
							timeoutMs: 60_000,
						}),
					).toBe(expected);
			const measured = spawnSync(pair.compiled, [], {
				encoding: "utf8",
				timeout: 60_000,
				env: { ...process.env, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" },
			});
			expect(measured.status, measured.stderr).toBe(0);
			expect(measured.stdout).toBe(expected);
			for (const counter of [
				"iteration_typed_callback_hits",
				"iteration_typed_callback_fallbacks",
				"iteration_direct_fallbacks",
			])
				expect(
					Number(measured.stderr.match(new RegExp(`${counter}=(\\d+)`))?.[1] ?? 0),
					counter,
				).toBeGreaterThan(0);
		},
		600_000,
	);

	it("retains foreign builtin species errors and local callback realms", () => {
		const realmFixture = "tests/local/typed-array-callback-realms.js";
		const expected = execFileSync(
			process.execPath,
			[
				"-e",
				`globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")};}};require(${JSON.stringify(path.resolve(realmFixture))});`,
			],
			{ encoding: "utf8" },
		);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture: realmFixture,
				name: `typed-callback-realms-${compiled}`,
				compiled,
				mainFile: "runtime/test262_main.c",
				outDir,
				config: resolveBuildConfig({ engine: { primordials: "mutable", realms: true } }),
			});
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(built.binaryPath, {
						env: { MAL_TEST262: "1", MAL_HOST_GC: "1", ...stress },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
		}
	}, 600_000);
});
