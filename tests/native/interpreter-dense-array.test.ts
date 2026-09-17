import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/interpreter-dense-array.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-interpreter-dense-array-"));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("interpreter-local dense array accesses", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf-8" });
		compiled = buildNativeBinary({
			fixture,
			name: "compiled-dense-array",
			compiled: true,
			evalEnabled: false,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "interpreter-dense-array",
			compiled: false,
			evalEnabled: false,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600_000);

	it("preserves guarded for-of semantics in compiled code", () => {
		expect(runToStdout(compiled, { env: { MAL_HOST_GC: "1" } })).toBe(expected);
	});

	it("keeps the compiled dense iterator cursor rooted under GC stress", () => {
		expect(
			runToStdout(compiled, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
		).toBe(expected);
	});

	it("preserves dense hits and all guarded fallbacks", () => {
		expect(runToStdout(interpreted, { env: { MAL_HOST_GC: "1" } })).toBe(expected);
	});

	it("keeps dense barriers and loop-backedge safepoints sound under GC stress", () => {
		expect(
			runToStdout(interpreted, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
		).toBe(expected);
	});

	it("avoids synchronization for dense hits while synchronizing misses", () => {
		const result = spawnSync(interpreted, [], {
			env: { ...process.env, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe(expected);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-interpreter-stats]"));
		expect(line).toBeDefined();
		const stats = line ?? "";
		expect(field(stats, "load_ic_sync_fallbacks")).toBeGreaterThan(0);
		expect(field(stats, "load_ic_sync_fallbacks")).toBeLessThan(1000);
		expect(field(stats, "store_ic_sync_fallbacks")).toBeGreaterThan(0);
		expect(field(stats, "store_ic_sync_fallbacks")).toBeLessThan(1000);
		expect(field(stats, "iterator_dense_hits")).toBeGreaterThan(2000);
		expect(field(stats, "iterator_sync_fallbacks")).toBeGreaterThan(0);
		expect(field(stats, "iterator_sync_fallbacks")).toBeLessThan(50);
	});
});
