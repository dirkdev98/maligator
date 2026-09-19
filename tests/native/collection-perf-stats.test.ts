import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary } from "../../src/test-harness.ts";

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

function reportLine(stderr: string, prefix: string, discriminator = ""): string {
	const line = stderr
		.split("\n")
		.find(
			(candidate) => candidate.startsWith(prefix) && candidate.includes(discriminator),
		);
	expect(line, `missing ${prefix} ${discriminator}`).toBeDefined();
	return line ?? "";
}

describe("collection performance statistics", () => {
	it("reports collection shape, lifetime, mutation, key, and iteration data", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-collection-perf-stats-"));
		const binary = buildNativeBinary({
			fixture: "tests/local/collection_perf_stats.js",
			name: "collection-perf-stats",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		const result = spawnSync(binary, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "collection-perf-stats");

		const maps = reportLine(result.stderr, "[perf-collection-profile]", "kind=map ");
		expect(field(maps, "allocations")).toBeGreaterThan(0);
		expect(field(maps, "observations")).toBeGreaterThan(0);
		expect(field(maps, "mutation_events")).toBeGreaterThan(0);
		expect(field(maps, "iteration_starts")).toBeGreaterThan(0);
		expect(field(maps, "iteration_steps")).toBeGreaterThan(0);

		const arrays = reportLine(result.stderr, "[perf-collection-profile]", "kind=array ");
		expect(field(arrays, "allocations")).toBeGreaterThan(0);
		expect(field(arrays, "observations")).toBeGreaterThan(0);
		expect(field(arrays, "mutation_events")).toBeGreaterThan(0);
		expect(field(arrays, "iteration_starts")).toBeGreaterThan(0);
		expect(field(arrays, "iteration_steps")).toBeGreaterThan(0);

		const kinds = reportLine(result.stderr, "[perf-array-kind-profile]");
		expect(field(kinds, "write_int32")).toBeGreaterThan(0);
		expect(field(kinds, "write_f64")).toBeGreaterThan(0);
		expect(field(kinds, "write_other")).toBeGreaterThan(0);
		expect(field(kinds, "kind_widenings")).toBeGreaterThan(0);

		const keys = reportLine(result.stderr, "[perf-collection-key-profile]", "kind=map ");
		for (const kind of ["int32", "string", "symbol", "object"]) {
			expect(field(keys, kind)).toBeGreaterThan(0);
		}
		const keyShapes = reportLine(
			result.stderr,
			"[perf-collection-key-shape]",
			"kind=map ",
		);
		for (const shape of ["int32", "f64", "string", "object"]) {
			expect(field(keyShapes, shape)).toBeGreaterThan(0);
		}
		const tracking = reportLine(result.stderr, "[perf-collection-tracking]");
		expect(field(tracking, "overflows")).toBe(0);
	}, 180_000);
});
