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
			expect(selected).toContain("Map.prototype.forEach");
			expect(selected).toContain("Set.prototype.forEach");
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
				config: resolveBuildConfig({ engine: { primordials: "mutable", realms: true } }),
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
