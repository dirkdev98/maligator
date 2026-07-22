import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-split-fresh-array-"));

function run(binary: string, env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...env },
		encoding: "utf-8",
		timeout: 60000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, "string-split-fresh-array");
	return result.stderr;
}

function perfField(stderr: string, field: string): number {
	return Number(stderr.match(new RegExp(`(?:^|\\s)${field}=([0-9]+)`))?.[1] ?? 0);
}

describe("String.prototype.split fresh dense results", () => {
	let compiled: string;
	let interpreted: string;
	let concurrent: string;
	let instrumented: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/string-split-fresh-array.js",
			name: "string-split-fresh-array",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/string-split-fresh-array.js",
			name: "string-split-fresh-array-ni",
			compiled: false,
			outDir,
		});
		concurrent = buildNativeBinary({
			fixture: "tests/local/string-split-fresh-array.js",
			name: "string-split-fresh-array-concurrent",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_GC_CONCURRENT: "1" },
		});
		instrumented = buildNativeBinary({
			fixture: "tests/local/string-split-fresh-array.js",
			name: "string-split-fresh-array-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	it("preserves split result and protocol semantics in compiled code", () => {
		run(compiled);
	});

	it("preserves split result and protocol semantics in interpreted code", () => {
		run(interpreted);
	});

	it("keeps dense result elements live under GC stress", () => {
		run(compiled, { ...STRESS_ENV, MAL_HOST_GC: "1" });
	});

	it("publishes dense result elements safely under concurrent GC", () => {
		run(concurrent, {
			...STRESS_ENV,
			MAL_HOST_GC: "1",
			MAL_GC_THRESHOLD: "262144",
			MAL_GC_MAJOR_EVERY: "1",
		});
	});

	it("attributes exact reserves and remaining geometric growth without fallback", () => {
		const stderr = run(instrumented, { MAL_PERF_STATS: "1" });
		expect(stderr).toContain("[perf-array-stats]");
		expect(perfField(stderr, "fresh_dense_stores")).toBeGreaterThan(0);
		expect(perfField(stderr, "fresh_dense_growths")).toBeGreaterThan(0);
		expect(perfField(stderr, "fresh_dense_fallbacks")).toBe(0);
		expect(perfField(stderr, "fresh_dense_exact_reserves")).toBeGreaterThan(0);
		expect(perfField(stderr, "fresh_dense_reserved_slots")).toBeGreaterThan(
			perfField(stderr, "fresh_dense_exact_reserves"),
		);
		expect(perfField(stderr, "fresh_dense_growths_avoided")).toBeGreaterThan(0);
	});
});
