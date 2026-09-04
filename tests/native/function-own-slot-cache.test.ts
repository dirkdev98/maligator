import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/function-own-slot-cache.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-function-own-slot-cache-"));
const expected = "function-own-slot-cache PASS\n";

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("function own-slot property cache", () => {
	let compiled: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "function-own-slot-cache",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	it("preserves callable property semantics under mutation and GC stress", () => {
		expect(
			runToStdout(compiled, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
		).toBe(expected);
	});

	it("serves script, native, and bound function properties from shape slots", () => {
		const result = spawnSync(compiled, [], {
			env: { ...process.env, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(expected);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-ic-stats]"));
		expect(line).toBeDefined();
		expect(field(line ?? "", "load_slow_mono_hits")).toBeGreaterThan(5_900);
	});
});
