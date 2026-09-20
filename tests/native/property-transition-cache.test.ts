import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-property-transition-cache-"));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? -1);
}

describe("ordinary property transition inline cache", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/property-transition-cache.js",
			name: "property-transition-cache",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/property-transition-cache.js",
			name: "property-transition-cache-ni",
			compiled: false,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600_000);

	it.each([
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	])("uses prototype-safe transition hits in %s mode", (_name, binary) => {
		const result = spawnSync(binary(), [], {
			env: {
				...process.env,
				MAL_PERF_STATS: "1",
				MAL_PERF_CONTROL: "1",
			},
			encoding: "utf-8",
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertExactLines(result.stdout, ["property-transition-cache PASS"]);
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-ic-stats]"));
		expect(line).toBeDefined();
		const stats = line ?? "";
		expect(field(stats, "store_transition_fills")).toBe(3);
		expect(field(stats, "store_transition_hits")).toBe(30);
		expect(field(stats, "define_transition_fills")).toBe(_name === "compiled" ? 2 : 0);
		expect(field(stats, "define_transition_hits")).toBe(_name === "compiled" ? 30 : 0);
		expect(field(stats, "prototype_epoch_invalidations")).toBeGreaterThan(0);
	});

	it.each([
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	])("keeps transition values sound under GC stress in %s mode", (_name, binary) => {
		const result = spawnSync(binary(), [], {
			env: {
				...process.env,
				MAL_PERF_STATS: "1",
				MAL_PERF_CONTROL: "1",
				MAL_HOST_GC: "1",
				...STRESS_ENV,
			},
			encoding: "utf-8",
			timeout: 60_000,
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertExactLines(result.stdout, ["property-transition-cache PASS"]);
	});
});
