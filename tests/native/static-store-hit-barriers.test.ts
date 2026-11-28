import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

const fixture = "tests/local/static-store-hit-barriers.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-store-hit-barriers-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function statistics(stderr: string): (name: string) => number {
	return (name) =>
		Number(stderr.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`, "m"))?.[1] ?? -1);
}

describe("static store hits under incremental collection", () => {
	const binaries = new Map<string, string>();

	beforeAll(() => {
		for (const compiled of [true, false]) {
			binaries.set(
				compiled ? "compiled" : "interpreted",
				buildNativeBinary({
					fixture,
					name: compiled ? "static-store-hit-barriers" : "static-store-hit-barriers-ni",
					compiled,
					outDir,
					environment: { ...process.env, MAL_PERF_STATS: "1" },
				}),
			);
		}
	}, 600_000);

	it.each(["compiled", "interpreted"])(
		"keeps stored references alive and Numbers exact while marking runs (%s)",
		(mode) => {
			const invocation = resolveHarnessExecutionInvocation(binaries.get(mode)!);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_THRESHOLD: "262144",
					MAL_GC_MAJOR_EVERY: "2",
					MAL_GC_VERIFY: "1",
					MAL_GC_STATS: "1",
					MAL_PERF_STATS: "1",
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			assertExactLines(result.stdout, ["static-store-hit-barriers PASS"]);
			const counter = statistics(result.stderr);
			expect(counter("cycles"), result.stderr).toBeGreaterThan(0);
			expect(counter("satb_high_water"), result.stderr).toBeGreaterThan(0);
			expect(counter("remembered_owners"), result.stderr).toBeGreaterThan(0);
			expect(counter("store_mono_hits"), result.stderr).toBeGreaterThan(
				100 * counter("store_fallbacks"),
			);
		},
	);
});
