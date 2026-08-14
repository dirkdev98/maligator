import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-invariant-json-map-template-"));

function run(
	binary: string,
	env: NodeJS.ProcessEnv = {},
	tag = "invariant-json-map-template",
): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...env },
		encoding: "utf-8",
		timeout: 60000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, tag);
	return result.stderr;
}

function field(stderr: string, name: string): number {
	const line = stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-invariant-json-map-stats]"));
	return Number(line?.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("linked invariant JSON.parse map templates", () => {
	let compiled: string;
	let interpreted: string;
	let concurrent: string;
	let instrumented: string;
	let adversarialCompiled: string;
	let adversarialInterpreted: string;
	let adversarialInstrumented: string;
	let patchedParseInstrumented: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/invariant-json-map-template.js",
			name: "invariant-json-map-template",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/invariant-json-map-template.js",
			name: "invariant-json-map-template-ni",
			compiled: false,
			outDir,
		});
		concurrent = buildNativeBinary({
			fixture: "tests/local/invariant-json-map-template.js",
			name: "invariant-json-map-template-concurrent",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_GC_CONCURRENT: "1" },
		});
		instrumented = buildNativeBinary({
			fixture: "tests/local/invariant-json-map-template.js",
			name: "invariant-json-map-template-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		adversarialCompiled = buildNativeBinary({
			fixture: "tests/local/invariant-json-map-template-adversarial.js",
			name: "invariant-json-map-template-adversarial",
			compiled: true,
			outDir,
		});
		adversarialInterpreted = buildNativeBinary({
			fixture: "tests/local/invariant-json-map-template-adversarial.js",
			name: "invariant-json-map-template-adversarial-ni",
			compiled: false,
			outDir,
		});
		adversarialInstrumented = buildNativeBinary({
			fixture: "tests/local/invariant-json-map-template-adversarial.js",
			name: "invariant-json-map-template-adversarial-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		patchedParseInstrumented = buildNativeBinary({
			fixture: "tests/local/invariant-json-map-template-patched-parse.js",
			name: "invariant-json-map-template-patched-parse-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	it("preserves fresh arrays, rows, mutation isolation, and property order", () => {
		run(compiled);
		run(interpreted);
	});

	it("keeps the private final-row template rooted under stress and concurrent GC", () => {
		run(compiled, { ...STRESS_ENV, MAL_HOST_GC: "1" });
		run(concurrent, { ...STRESS_ENV, MAL_HOST_GC: "1" });
	});

	it("falls back for changed text, object values, and patched Math/map/species", () => {
		run(adversarialCompiled, {}, "invariant-json-map-template-adversarial");
		run(adversarialInterpreted, {}, "invariant-json-map-template-adversarial");
		const stderr = run(
			adversarialInstrumented,
			{ MAL_PERF_STATS: "1" },
			"invariant-json-map-template-adversarial",
		);
		expect(field(stderr, "candidates")).toBe(14);
		expect(field(stderr, "fills")).toBe(2);
		expect(field(stderr, "hits")).toBe(0);
		expect(field(stderr, "misses")).toBe(14);
		expect(field(stderr, "guard_fallbacks")).toBe(2);
		const parseStderr = run(
			patchedParseInstrumented,
			{ MAL_PERF_STATS: "1" },
			"invariant-json-map-template-patched-parse",
		);
		expect(field(parseStderr, "candidates")).toBe(3);
		expect(field(parseStderr, "fills")).toBe(0);
		expect(field(parseStderr, "hits")).toBe(0);
		expect(field(parseStderr, "misses")).toBe(3);
	});

	it("reports exact linked fill, clone, and elision counts", () => {
		const stderr = run(instrumented, { MAL_PERF_STATS: "1" });
		expect(field(stderr, "candidates")).toBe(12);
		expect(field(stderr, "fills")).toBe(2);
		expect(field(stderr, "hits")).toBe(10);
		expect(field(stderr, "misses")).toBe(2);
		expect(field(stderr, "map_calls_elided")).toBe(10);
		expect(field(stderr, "callback_calls_elided")).toBe(20);
		expect(field(stderr, "rows_cloned")).toBe(20);
		expect(field(stderr, "intermediate_containers_elided")).toBe(40);
		expect(field(stderr, "property_loads_elided")).toBe(160);
		expect(field(stderr, "exclusion_checks_elided")).toBe(540);
	});

	it("silently abandons private fill cell, raw-buffer, and partial-row failures", () => {
		for (const mode of ["array", "raw", "partial-row"]) {
			const stderr = run(instrumented, {
				...STRESS_ENV,
				MAL_HOST_GC: "1",
				MAL_PERF_STATS: "1",
				MAL_JSON_MAP_TEMPLATE_FAIL_FILL_ALLOC: mode,
			});
			expect(field(stderr, "candidates"), mode).toBe(12);
			expect(field(stderr, "fills"), mode).toBe(0);
			expect(field(stderr, "hits"), mode).toBe(0);
			expect(field(stderr, "misses"), mode).toBe(12);
		}
	});
});
