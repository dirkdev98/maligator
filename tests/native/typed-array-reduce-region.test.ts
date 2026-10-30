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

const fixture = "tests/local/typed-array-reduce-region.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-typed-reduce-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("TypedArray reduction invocation", () => {
	it("retains builtin and callback realms across foreign reductions and throws", () => {
		const realmFixture = "tests/local/typed-array-reduce-realms.js";
		const expected = execFileSync(
			process.execPath,
			[
				"-e",
				`globalThis.$262 = { createRealm() { return { global: require("node:vm").runInNewContext("globalThis") }; } }; require(${JSON.stringify(path.resolve(realmFixture))});`,
			],
			{ encoding: "utf8" },
		);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture: realmFixture,
				name: `typed-reduce-realms-${compiled}`,
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

	it.each(["mutable", "locked"] as const)(
		"resumes boxed values without replay and keeps live captures under %s primordials",
		(primordials) => {
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `typed-reduce-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			expect(
				pair.programImage.native.functions.some((fn) =>
					fn.storage!.callbackTransports.some((plan) => plan.numericReduction),
				),
			).toBe(true);
			for (const name of ["typedSnapshotReducer", "typedRestReducer"]) {
				const callback = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(callback, name).toBeDefined();
				expect(
					pair.programImage.native.functions.some((fn) =>
						fn.storage!.callbackTransports.some(
							(plan) =>
								plan.functionIndex === callback.functionIndex &&
								plan.argumentCount === 4 &&
								plan.numericReduction,
						),
					),
				).toBe(true);
			}
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
			expect(
				Number(measured.stderr.match(/iteration_numeric_reduce_calls=(\d+)/)?.[1] ?? 0),
			).toBeGreaterThan(0);
		},
		600_000,
	);
});
