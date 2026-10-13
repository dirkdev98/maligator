import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/numeric-sort-invocation.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-numeric-sort-invocation-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("numeric sort invocation contracts", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "numeric-sort-invocation",
			outDir,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		({ compiled, interpreted } = pair);
		const image = pair.programImage;
		const targets = image.native.functions.flatMap((fn) =>
			fn.instructions.flatMap((plan) => {
				if (plan?.kind !== "call" || plan.numericSortCallback === undefined) return [];
				const target = image.native.functions[plan.numericSortCallback.functionIndex]!;
				return [
					String.fromCharCode(
						...image.runtime.stringConstants[target.body.nameStringIndex]!,
					),
				];
			}),
		);
		for (const target of [
			"snapshot",
			"missing",
			"defaults",
			"rest",
			"noFormals",
			"capture",
			"throwing",
		]) {
			expect(targets, target).toContain(target);
		}
	}, 600_000);

	it("preserves arguments, live captures, activation identity, re-entry and throws", () => {
		for (const binary of [compiled, interpreted]) {
			for (const stress of [{}, STRESS_ENV]) {
				expect(
					runToStdout(binary, {
						env: { MAL_HOST_GC: "1", ...stress },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
			}
		}
	});

	it("executes selected comparator entries", () => {
		const result = spawnSync(compiled, [], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" },
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(expected);
		expect(
			Number(result.stderr.match(/numeric_sort_callback_calls=(\d+)/)?.[1] ?? 0),
		).toBeGreaterThan(0);
	});
});
