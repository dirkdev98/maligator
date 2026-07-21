import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-perf-stats-"));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`${name}=([0-9]+)`))?.[1] ?? 0);
}

function reportLine(stderr: string, prefix: string, discriminator?: string): string {
	const line = stderr
		.split("\n")
		.find(
			(candidate) =>
				candidate.startsWith(prefix) && candidate.includes(discriminator ?? ""),
		);
	expect(line, `missing ${prefix} ${discriminator ?? ""}`).toBeDefined();
	return line ?? "";
}

function withoutPerfStats(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.MAL_PERF_STATS;
	return env;
}

describe("opt-in performance statistics", () => {
	let binary: string;
	let defaultBinary: string;

	beforeAll(() => {
		defaultBinary = buildNativeBinary({
			fixture: "tests/local/perf_stats.js",
			name: "perf-stats",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "0" },
		});
		binary = buildNativeBinary({
			fixture: "tests/local/perf_stats.js",
			name: "perf-stats",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	it("compiles counters out of default builds", () => {
		expect(binary).not.toBe(defaultBinary);
		expect(binary).toContain("-perf");
		const result = spawnSync(defaultBinary, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		assertPassLine(result.stdout, "perf-stats");
		expect(result.stderr).not.toContain("[perf-");
	});

	it("keeps instrumented builds silent unless enabled at runtime", () => {
		const result = spawnSync(binary, [], {
			env: withoutPerfStats(),
			encoding: "utf-8",
		});
		expect(result.status).toBe(0);
		assertPassLine(result.stdout, "perf-stats");
		expect(result.stderr).not.toContain("[perf-");
	});

	it("attributes key, table, shape, and inline-cache activity", () => {
		const result = spawnSync(binary, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "perf-stats");

		const strings = reportLine(result.stderr, "[perf-string-stats]");
		expect(field(strings, "key_equals_calls")).toBeGreaterThan(0);
		expect(field(strings, "key_string_fallbacks")).toBeGreaterThan(0);
		expect(field(strings, "string_memcmp_calls")).toBeGreaterThan(0);

		const intrinsics = reportLine(result.stderr, "[perf-intrinsic-stats]");
		expect(field(intrinsics, "calls")).toBeGreaterThan(0);
		expect(field(intrinsics, "hits")).toBeGreaterThan(0);

		for (const role of ["object", "atoms", "map"]) {
			const table = reportLine(result.stderr, "[perf-table-stats]", `role=${role} `);
			expect(field(table, "find_calls")).toBeGreaterThan(0);
			if (role === "map") {
				expect(field(table, "find_calls")).toBe(
					field(table, "lookups") +
						field(table, "upserts") +
						field(table, "slot_growths"),
				);
			}
		}

		for (const caller of ["get_own", "define_own", "load_ic"]) {
			const shape = reportLine(result.stderr, "[perf-shape-stats]", `caller=${caller} `);
			expect(field(shape, "calls")).toBeGreaterThan(0);
		}

		const ic = reportLine(result.stderr, "[perf-ic-stats]");
		const loadHits =
			field(ic, "load_mono_hits") +
			field(ic, "load_region_hits") +
			field(ic, "load_slow_mono_hits");
		expect(loadHits).toBeGreaterThan(0);
		expect(field(ic, "load_fallbacks")).toBeGreaterThan(0);
		expect(field(ic, "store_fallbacks")).toBeGreaterThan(0);
	});
});
