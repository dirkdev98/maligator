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

const fixture = "tests/local/sort-callback-continuation.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-sort-continuation-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("sort callback continuation after numeric admission declines", () => {
	it.each(["mutable", "locked"] as const)(
		"retains exact boxed invocations and coercion under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `sort-continuation-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { primordials, eval: false, realms: false },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const image = pair.programImage;
			const selectedNames = image.native.functions.flatMap((fn) =>
				fn.instructions.flatMap((plan) => {
					if (plan?.kind !== "call" || !plan.numericSortCallback) return [];
					const callback =
						image.native.functions[plan.numericSortCallback.functionIndex]!;
					return [
						String.fromCharCode(
							...image.runtime.stringConstants[callback.body.nameStringIndex]!,
						),
					];
				}),
			);
			for (const name of ["orderedFallback", "nestedFallback", "operandResult"])
				expect(selectedNames).toContain(name);
			for (const kind of ["array", "typed", "mixed"]) {
				const env = { SORT_CALLBACK_KIND: kind, MAL_HOST_GC: "1" };
				const expected = execFileSync(process.execPath, [fixture], {
					encoding: "utf8",
					env: { ...process.env, ...env },
				});
				for (const binary of [pair.compiled, pair.interpreted])
					for (const stress of [{}, STRESS_ENV])
						expect(
							runToStdout(binary, { env: { ...env, ...stress }, timeoutMs: 60_000 }),
						).toBe(expected);
				const measured = spawnSync(pair.compiled, [], {
					encoding: "utf8",
					timeout: 60_000,
					env: { ...process.env, ...env, MAL_PERF_STATS: "1" },
				});
				expect(measured.status, measured.stderr).toBe(0);
				expect(measured.stdout).toBe(expected);
				const exact = measured.stderr.match(/iteration_exact_callback_calls=(\d+)/);
				const numeric = measured.stderr.match(/numeric_sort_callback_calls=(\d+)/);
				expect(exact, measured.stderr).not.toBeNull();
				expect(Number(exact![1]), kind).toBeGreaterThan(0);
				expect(numeric, measured.stderr).not.toBeNull();
				if (kind === "mixed") expect(Number(numeric![1]), kind).toBeGreaterThan(0);
				else expect(Number(numeric![1]), kind).toBe(0);
			}
		},
		600_000,
	);

	it("preserves foreign builtin result realms and local comparator exceptions", () => {
		const realmFixture = "tests/local/sort-callback-realms.js";
		const expected = execFileSync(
			process.execPath,
			[
				"-e",
				`globalThis.$262={createRealm(){return {global:require("node:vm").runInNewContext("globalThis")};}};require(${JSON.stringify(join(process.cwd(), realmFixture))});`,
			],
			{ encoding: "utf8" },
		);
		for (const compiled of [true, false]) {
			const built = buildNativeBinaryResult({
				fixture: realmFixture,
				name: `sort-callback-realms-${compiled}`,
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
