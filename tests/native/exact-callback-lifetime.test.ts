import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

const fixture = "tests/local/exact-callback-lifetime.js";
const outDir = mkdtempSync(join(tmpdir(), "mal-exact-callback-lifetime-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("exact callback contexts across runtime compilation", () => {
	it.each(["mutable", "locked"] as const)(
		"resolves relocated function metadata under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `exact-callback-lifetime-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { eval: true, realms: true, primordials },
				}),
				environment: { ...process.env, MAL_PERF_STATS: "1" },
			});
			const image = pair.programImage;
			const callback = (name: string) =>
				image.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
						) === name,
				)!;
			const boxed = callback("growingBoxed");
			const comparator = callback("growingComparator");
			expect(boxed).toBeDefined();
			expect(comparator).toBeDefined();
			expect(
				image.native.functions.some((fn) =>
					fn.instructions.some(
						(plan) =>
							plan?.kind === "call" &&
							plan.directCallbackFunctionIndex === boxed.functionIndex,
					),
				),
			).toBe(true);
			expect(
				image.native.functions.some((fn) =>
					fn.instructions.some(
						(plan) =>
							plan?.kind === "call" &&
							plan.numericSortCallback?.functionIndex === comparator.functionIndex,
					),
				),
			).toBe(true);
			for (const kind of ["boxed", "reduce", "sort"]) {
				const env = { EXACT_CALLBACK_KIND: kind, MAL_HOST_GC: "1" };
				const expected = execFileSync(process.execPath, [fixture], {
					encoding: "utf8",
					env: { ...process.env, ...env },
				});
				const compiled = spawnSync(pair.compiled, [], {
					encoding: "utf8",
					timeout: 60_000,
					env: { ...process.env, ...env, MAL_PERF_STATS: "1" },
				});
				expect(compiled.status, compiled.stderr).toBe(0);
				expect(compiled.stdout).toBe(expected);
				const counter =
					kind === "sort"
						? "numeric_sort_callback_calls"
						: "iteration_exact_compiled_callback_calls";
				expect(
					Number(compiled.stderr.match(new RegExp(`${counter}=(\\d+)`))?.[1] ?? 0),
				).toBeGreaterThan(0);
				expect(runToStdout(pair.interpreted, { env, timeoutMs: 60_000 })).toBe(expected);
			}
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			for (const binary of [pair.compiled, pair.interpreted])
				expect(
					runToStdout(binary, {
						env: { MAL_HOST_GC: "1", MAL_GC_STRESS: "1000", MAL_GC_VERIFY: "1" },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
		},
		600_000,
	);
});
