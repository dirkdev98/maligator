import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-numeric-reduce-fold-"));

function run(binary: string, tag: string, env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...env },
		encoding: "utf-8",
		timeout: 60000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, tag);
	return result.stdout;
}

function field(stderr: string, name: string): number {
	const line = stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-numeric-fold-stats]"));
	return Number(line?.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("native numeric reduce fold", () => {
	let compiled: string;
	let interpreted: string;
	let counts: string;
	let countsLocked: string;
	let countsInterpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/numeric-reduce-fold.js",
			name: "numeric-reduce-fold",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/numeric-reduce-fold.js",
			name: "numeric-reduce-fold-ni",
			compiled: false,
			outDir,
		});
		counts = buildNativeBinary({
			fixture: "tests/local/numeric-reduce-fold-counts.js",
			name: "numeric-reduce-fold-counts",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		countsInterpreted = buildNativeBinary({
			fixture: "tests/local/numeric-reduce-fold-counts.js",
			name: "numeric-reduce-fold-counts-ni",
			compiled: false,
			outDir,
		});
		countsLocked = buildNativeBinary({
			fixture: "tests/local/numeric-reduce-fold-counts.js",
			name: "numeric-reduce-fold-counts-locked",
			compiled: true,
			outDir,
			config: resolveBuildConfig({}),
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	it("produces bit-identical results on both backends", () => {
		const compiledOut = run(compiled, "numeric-reduce-fold");
		const interpretedOut = run(interpreted, "numeric-reduce-fold");
		expect(compiledOut).toBe(interpretedOut);
	});

	it("keeps folding correct under stress collection", () => {
		const stdout = run(counts, "numeric-reduce-fold-counts", STRESS_ENV);
		expect(stdout).toBe(run(countsInterpreted, "numeric-reduce-fold-counts", STRESS_ENV));
	});

	it("folds every admitted execution with no guard fallbacks", () => {
		const result = spawnSync(counts, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
			timeout: 60000,
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "numeric-reduce-fold-counts");
		expect(field(result.stderr, "candidates")).toBe(100);
		expect(field(result.stderr, "regions")).toBe(100);
		expect(field(result.stderr, "guard_fallbacks")).toBe(0);
		expect(field(result.stderr, "element_fallbacks")).toBe(0);
		expect(field(result.stderr, "callback_calls_elided")).toBe(10000);
		expect(field(result.stderr, "math_calls_elided")).toBe(30000);
	});

	it("executes the same region with world-invariant identities", () => {
		const result = spawnSync(countsLocked, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
			timeout: 60000,
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "numeric-reduce-fold-counts");
		expect(field(result.stderr, "regions")).toBe(100);
		expect(field(result.stderr, "guard_fallbacks")).toBe(0);
		expect(field(result.stderr, "callback_calls_elided")).toBe(10000);
	});
});
