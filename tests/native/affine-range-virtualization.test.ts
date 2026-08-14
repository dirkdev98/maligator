import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/affine-range-virtualization.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-affine-range-virtualization-"));

function run(binary: string, env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...env },
		encoding: "utf-8",
		timeout: 60_000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, "affine-range-virtualization");
	return result.stderr;
}

function field(stderr: string, name: string): number {
	const line = stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-array-stats]"));
	return Number(line?.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("private identity affine range virtualization", () => {
	let compiled: string;
	let interpreted: string;
	let instrumented: string;
	let concurrent: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "affine-range-virtualization",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "affine-range-virtualization-ni",
			compiled: false,
			outDir,
		});
		instrumented = buildNativeBinary({
			fixture,
			name: "affine-range-virtualization-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		concurrent = buildNativeBinary({
			fixture,
			name: "affine-range-virtualization-concurrent",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_GC_CONCURRENT: "1" },
		});
	}, 600_000);

	it("preserves compiled, interpreted, and poisoned-prototype semantics", () => {
		run(compiled);
		run(interpreted);
	});

	it("keeps all original polls and fallback state safe under GC stress", () => {
		run(compiled, { ...STRESS_ENV, MAL_HOST_GC: "1" });
		run(concurrent, { ...STRESS_ENV, MAL_HOST_GC: "1" });
	});

	it("reports exact virtual and fallback work", () => {
		const stderr = run(instrumented, { MAL_PERF_STATS: "1" });
		expect(field(stderr, "affine_range_candidates")).toBe(6);
		expect(field(stderr, "affine_range_virtualizations")).toBe(3);
		expect(field(stderr, "affine_range_guard_fallbacks")).toBe(3);
		expect(field(stderr, "affine_range_allocations_elided")).toBe(3);
		expect(field(stderr, "affine_range_stores_elided")).toBe(48);
		expect(field(stderr, "affine_range_loads_elided")).toBe(96);
	});
});
