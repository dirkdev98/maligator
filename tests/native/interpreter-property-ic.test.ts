import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/interpreter-property-ic.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-interpreter-property-ic-"));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("localized interpreter property inline caches", () => {
	let expected: string;
	let compiled: string;
	let compiledMultiVm: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf-8" });
		compiled = buildNativeBinary({
			fixture,
			name: "compiled-property-ic",
			compiled: true,
			outDir,
		});
		compiledMultiVm = buildNativeBinary({
			fixture,
			name: "compiled-property-ic-multi-vm",
			compiled: true,
			mainFile: "runtime/call_cache_test_main.c",
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "interpreter-property-ic",
			compiled: false,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600_000);

	it("keeps cache mode transitions sound in compiled property sites", () => {
		expect(runToStdout(compiled, { env: { MAL_HOST_GC: "1" } })).toBe(expected);
	});

	it("does not retain property-site or region state across sequential VMs", () => {
		expect(runToStdout(compiledMultiVm, { env: { MAL_HOST_GC: "1" } })).toBe(
			expected + expected,
		);
	});

	it("preserves own, inherited, exotic, invalidation, accessor, and proxy semantics", () => {
		expect(runToStdout(interpreted, { env: { MAL_HOST_GC: "1" } })).toBe(expected);
	});

	it("keeps barriered local stores sound under GC stress", () => {
		expect(
			runToStdout(interpreted, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
		).toBe(expected);
	});

	it("keeps proven hits local and synchronizes excluded cases", () => {
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
		expect(field(stats, "local_load_ic_hits")).toBeGreaterThan(7000);
		expect(field(stats, "local_store_ic_hits")).toBeGreaterThan(4000);
		expect(field(stats, "load_ic_sync_fallbacks")).toBeGreaterThan(0);
		expect(field(stats, "store_ic_sync_fallbacks")).toBeGreaterThan(0);
		expect(field(stats, "normal_helper_continuations")).toBeGreaterThan(0);

		const icLine = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-ic-stats]"));
		expect(icLine).toBeDefined();
		const icStats = icLine ?? "";
		expect(field(icStats, "load_inherited_hits")).toBeGreaterThan(1500);
		expect(field(icStats, "load_missing_hits")).toBeGreaterThan(1800);
		expect(field(icStats, "load_missing_fills")).toBeGreaterThan(0);
		expect(field(icStats, "prototype_epoch_invalidations")).toBeGreaterThan(0);
		expect(field(icStats, "prototype_epoch_finalize")).toBeGreaterThan(0);

		const slotLine = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-known-own-slot-stats]"));
		expect(slotLine).toBeDefined();
		expect(field(slotLine ?? "", "hits")).toBeGreaterThan(1500);
	});
});
