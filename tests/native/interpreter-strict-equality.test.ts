import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/interpreter-strict-equality.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-interpreter-strict-equality-"));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("localized interpreter strict equality", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf-8" });
		compiled = buildNativeBinary({
			fixture,
			name: "interpreter-strict-equality-compiled",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "interpreter-strict-equality-interpreted",
			compiled: false,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600_000);

	it("matches Node for strict equality value and string semantics", () => {
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
		}
	});

	it("preserves strict equality roots under GC stress on both backends", () => {
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 })).toBe(expected);
		}
	});

	it("keeps direct strict hits local and distinct strings at helper boundaries", () => {
		const result = spawnSync(interpreted, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(expected);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-interpreter-stats]"));
		expect(line).toBeDefined();
		const stats = line ?? "";
		const directHits = field(stats, "strict_direct_hits");
		const stringFallbacks = field(stats, "strict_string_fallbacks");
		expect(directHits).toBeGreaterThan(5000);
		expect(stringFallbacks).toBeGreaterThanOrEqual(64);
		expect(field(stats, "state_syncs")).toBeGreaterThanOrEqual(stringFallbacks);
	});
});
