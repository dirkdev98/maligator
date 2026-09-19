import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-map-get-set-cache-"));
const fixture = "tests/local/map-get-set-cache.js";

function run(binary: string, env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, MAL_HOST_GC: "1", ...env },
		encoding: "utf-8",
		timeout: 60_000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, "map-get-set-cache");
	return result.stderr;
}

function perfField(stderr: string, field: string): number {
	return Number(stderr.match(new RegExp(`(?:^|\\s)${field}=([0-9]+)`))?.[1] ?? -1);
}

describe("Map get-to-set table handle reuse", () => {
	let binary: string;
	let instrumented: string;

	beforeAll(() => {
		binary = buildNativeBinary({ fixture, name: "map-get-set-cache", outDir });
		instrumented = buildNativeBinary({
			fixture,
			name: "map-get-set-cache-perf",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600_000);

	it("preserves Map semantics through invalidation and rehash", () => {
		run(binary);
	});

	it("survives GC stress and verification", () => {
		run(binary, STRESS_ENV);
	});

	it("reports exact cache checks, hits, and misses", () => {
		const stderr = run(instrumented, { MAL_PERF_STATS: "1" });
		expect(stderr).toContain("[perf-map-stats]");
		expect(perfField(stderr, "get_set_cache_checks")).toBe(1957);
		expect(perfField(stderr, "get_set_cache_hits")).toBe(853);
		expect(perfField(stderr, "get_set_cache_misses")).toBe(1104);
	});
});
