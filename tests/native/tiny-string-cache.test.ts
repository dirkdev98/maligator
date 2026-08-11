import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-tiny-string-cache-"));
const fixture = "tests/local/tiny-string-cache.js";
const mainFile = "runtime/test262_main.c";

function run(binary: string, env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, MAL_TEST262: "1", ...env },
		encoding: "utf-8",
		timeout: 60000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, "tiny-string-cache");
	return result.stderr;
}

function perfField(stderr: string, name: string): number {
	return Number(stderr.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("bounded tiny-string cache", () => {
	let compiled: string;
	let interpreted: string;
	let concurrent: string;
	let instrumented: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "tiny-string-cache",
			compiled: true,
			mainFile,
			outDir,
			realmsEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "tiny-string-cache-ni",
			compiled: false,
			mainFile,
			outDir,
			realmsEnabled: true,
		});
		concurrent = buildNativeBinary({
			fixture,
			name: "tiny-string-cache-concurrent",
			compiled: true,
			mainFile,
			outDir,
			realmsEnabled: true,
			environment: { ...process.env, MAL_GC_CONCURRENT: "1" },
		});
		instrumented = buildNativeBinary({
			fixture,
			name: "tiny-string-cache-perf",
			compiled: true,
			mainFile,
			outDir,
			realmsEnabled: true,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	it("preserves string, property, collection, and Realm semantics in compiled code", () => {
		run(compiled);
	});

	it("preserves the same semantics in interpreted code", () => {
		run(interpreted);
	});

	it("keeps cached representatives live under verified GC stress", () => {
		run(compiled, { ...STRESS_ENV, MAL_HOST_GC: "1" });
	});

	it("replaces rooted representatives safely during concurrent GC", () => {
		run(concurrent, {
			...STRESS_ENV,
			MAL_HOST_GC: "1",
			MAL_GC_THRESHOLD: "262144",
			MAL_GC_MAJOR_EVERY: "1",
		});
	});

	it("attributes hits, collisions, and property-atom promotion", () => {
		const stderr = run(instrumented, { MAL_PERF_STATS: "1" });
		expect(stderr).toContain("[perf-string-allocation-stats]");
		expect(perfField(stderr, "tiny_cache_hits")).toBeGreaterThan(1000);
		expect(perfField(stderr, "tiny_cache_misses")).toBeGreaterThan(0);
		expect(perfField(stderr, "tiny_cache_replacements")).toBeGreaterThan(0);
		expect(perfField(stderr, "tiny_cache_promotions")).toBeGreaterThan(0);
		expect(perfField(stderr, "small_uint_cache_hits")).toBeGreaterThan(3000);
		expect(perfField(stderr, "small_uint_cache_misses")).toBe(1024);
	});
});
