import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-perf-stats-"));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
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
	let interpretedBinary: string;

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
		interpretedBinary = buildNativeBinary({
			fixture: "tests/local/perf_stats.js",
			name: "perf-stats-interpreted",
			compiled: false,
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

	it("resets an instrumented attribution window only under explicit control", () => {
		const result = spawnSync(binary, [], {
			env: {
				...process.env,
				MAL_PERF_STATS: "1",
				MAL_PERF_CONTROL: "1",
			},
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "perf-stats");
		const transitions = reportLine(result.stderr, "[perf-shape-transition-stats]");
		expect(field(transitions, "calls")).toBeLessThan(10);
		const ic = reportLine(result.stderr, "[perf-ic-stats]");
		expect(field(ic, "store_fallbacks")).toBeGreaterThan(0);
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
		expect(field(strings, "reverse_search_calls")).toBeGreaterThan(0);
		expect(field(strings, "reverse_search_candidates")).toBeGreaterThan(0);
		expect(field(strings, "reverse_search_first_unit_rejects")).toBeGreaterThan(0);
		expect(field(strings, "reverse_search_memcmp_calls")).toBeGreaterThan(0);
		expect(field(strings, "unit_scan_word_blocks")).toBeGreaterThan(0);
		expect(field(strings, "unit_scan_candidate_blocks")).toBeGreaterThan(0);
		expect(field(strings, "unit_scan_scalar_code_units")).toBeGreaterThan(0);
		expect(field(strings, "case_calls")).toBe(4);
		expect(field(strings, "case_input_code_units")).toBeGreaterThan(0);
		expect(field(strings, "case_reuses")).toBe(2);
		expect(field(strings, "case_changed_allocations")).toBe(2);
		expect(field(strings, "case_changed_code_units")).toBeGreaterThan(0);

		const regexp = reportLine(result.stderr, "[perf-regexp-stats]");
		expect(field(regexp, "exec_calls")).toBeGreaterThan(0);
		expect(field(regexp, "fast_exec_calls")).toBeGreaterThan(0);
		expect(field(regexp, "ascii_exec_calls")).toBeGreaterThan(0);
		expect(field(regexp, "ascii_cache_fills")).toBeGreaterThan(0);
		expect(field(regexp, "utf16_exec_calls")).toBe(1);

		const stringAllocations = reportLine(result.stderr, "[perf-string-allocation-stats]");
		expect(
			field(stringAllocations, "copy_allocations") +
				field(stringAllocations, "ascii_allocations") +
				field(stringAllocations, "owned_allocations"),
		).toBeGreaterThan(0);
		expect(field(stringAllocations, "inline_allocations")).toBeGreaterThan(0);
		expect(field(stringAllocations, "inline_concat_results")).toBeGreaterThan(0);
		expect(field(stringAllocations, "slice_calls")).toBeGreaterThan(0);
		expect(field(stringAllocations, "slice_dependent_results")).toBeGreaterThan(0);
		expect(field(stringAllocations, "cons_allocations")).toBeGreaterThan(0);
		expect(field(stringAllocations, "flatten_calls")).toBeGreaterThan(0);
		expect(field(stringAllocations, "flatten_cons_nodes")).toBeGreaterThan(0);

		const intrinsics = reportLine(result.stderr, "[perf-intrinsic-stats]");
		expect(field(intrinsics, "calls")).toBeGreaterThan(0);
		expect(field(intrinsics, "cache_hits")).toBeGreaterThan(0);
		expect(field(intrinsics, "cache_fills")).toBeGreaterThan(0);
		expect(field(intrinsics, "direct_calls")).toBeGreaterThan(0);
		expect(field(intrinsics, "direct_hits")).toBeGreaterThan(0);
		expect(field(intrinsics, "hits")).toBeGreaterThan(0);
		expect(
			field(intrinsics, "cache_hits") +
				field(intrinsics, "hits") +
				field(intrinsics, "misses"),
		).toBe(field(intrinsics, "calls"));
		const attributedNameCalls = result.stderr
			.split("\n")
			.filter((line) => line.startsWith("[perf-intrinsic-name]"))
			.reduce((sum, line) => sum + field(line, "calls"), 0);
		expect(attributedNameCalls).toBe(field(intrinsics, "calls"));
		const intrinsicName = reportLine(
			result.stderr,
			"[perf-intrinsic-name]",
			"name=push ",
		);
		expect(field(intrinsicName, "calls")).toBeGreaterThan(0);
		const properties = reportLine(result.stderr, "[perf-property-stats]");
		expect(field(properties, "ensure_calls")).toBeGreaterThan(0);
		expect(field(properties, "ensure_inserts")).toBeGreaterThan(0);
		expect(field(properties, "constant_atom_hits")).toBeGreaterThan(1000);
		const allocations = reportLine(result.stderr, "[perf-allocation-stats]");
		expect(
			field(allocations, "empty_objects") + field(allocations, "shaped_objects"),
		).toBeGreaterThan(0);
		expect(field(allocations, "stack_objects")).toBeGreaterThan(0);
		expect(field(allocations, "stack_materializations")).toBe(1);
		expect(field(allocations, "accessor_sidecar_allocations")).toBeGreaterThan(0);
		expect(field(allocations, "accessor_sidecar_frees")).toBeGreaterThan(0);
		expect(field(allocations, "function_property_cache_allocations")).toBeGreaterThan(0);
		expect(field(allocations, "function_property_cache_bytes")).toBeGreaterThan(0);
		expect(field(allocations, "function_literal_cache_allocations")).toBeGreaterThan(0);
		expect(field(allocations, "function_literal_cache_bytes")).toBeGreaterThan(0);
		expect(result.stderr).not.toContain("name=Intl.Segmenter ");

		for (const role of ["object", "atoms", "map"]) {
			const table = reportLine(result.stderr, "[perf-table-stats]", `role=${role} `);
			expect(field(table, "find_calls")).toBeGreaterThan(0);
			if (role === "atoms") {
				// Each access constructs a fresh but equal "beta" string. Property
				// conversion must converge those strings on one VM-lifetime identity.
				expect(field(table, "lookup_hits")).toBeGreaterThan(1000);
			}
			if (role === "map") {
				expect(field(table, "find_calls")).toBe(
					field(table, "lookups") +
						field(table, "upserts") +
						field(table, "deletes") +
						field(table, "slot_growths"),
				);
				expect(field(table, "delete_cluster_scans")).toBeGreaterThan(0);
				expect(field(table, "delete_slot_moves")).toBeGreaterThan(0);
				expect(field(table, "storage_allocations")).toBeGreaterThan(0);
				expect(field(table, "storage_releases")).toBeGreaterThan(0);
				expect(field(table, "entry_shrinks")).toBeGreaterThan(0);
				expect(field(table, "compactions")).toBeGreaterThan(0);
			}
		}

		for (const caller of ["get_own", "define_own", "load_ic"]) {
			const shape = reportLine(result.stderr, "[perf-shape-stats]", `caller=${caller} `);
			expect(field(shape, "calls")).toBeGreaterThan(0);
		}
		const transitions = reportLine(result.stderr, "[perf-shape-transition-stats]");
		expect(field(transitions, "index_lookups")).toBeGreaterThan(0);
		expect(field(transitions, "index_hits")).toBeGreaterThan(0);
		expect(field(transitions, "index_builds")).toBeGreaterThan(0);

		const modeReplacements = reportLine(result.stderr, "[perf-ic-mode-stats]");
		expect(field(modeReplacements, "replacements")).toBeGreaterThan(0);
		expect(field(modeReplacements, "cross_mode")).toBeGreaterThan(0);
		const dependencies = reportLine(result.stderr, "[perf-prototype-dependency-stats]");
		expect(field(dependencies, "register_calls")).toBeGreaterThan(0);
		expect(field(dependencies, "register_nodes")).toBeGreaterThan(0);
		expect(field(dependencies, "unregister_calls")).toBeGreaterThan(0);
		expect(field(dependencies, "unregister_scan_steps")).toBeGreaterThan(0);

		const ic = reportLine(result.stderr, "[perf-ic-stats]");
		const loadHits = field(ic, "load_mono_hits") + field(ic, "load_slow_mono_hits");
		expect(loadHits).toBeGreaterThan(0);
		expect(field(ic, "load_fallbacks")).toBeGreaterThan(0);
		expect(field(ic, "load_primitive_hits")).toBeGreaterThan(3000);
		expect(field(ic, "load_string_length_hits")).toBeGreaterThan(1000);
		expect(field(ic, "load_array_length_hits")).toBeGreaterThan(1000);
		expect(
			field(ic, "load_primitive_hits") +
				field(ic, "load_string_length_hits") +
				field(ic, "load_array_length_hits"),
		).toBeGreaterThan(field(ic, "load_fallbacks"));
		expect(field(ic, "store_fallbacks")).toBeGreaterThan(0);
	});

	it("keeps cached atoms live through GC stress and tears the VM down", () => {
		const result = spawnSync(binary, [], {
			env: {
				...process.env,
				MAL_PERF_STATS: "1",
				MAL_GC_STRESS: "1",
				MAL_GC_VERIFY: "1",
				MAL_GC_AT_EXIT: "1",
			},
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "perf-stats");
		const intrinsics = reportLine(result.stderr, "[perf-intrinsic-stats]");
		expect(field(intrinsics, "cache_hits")).toBeGreaterThan(0);
	});

	it("uses inline-cache fast paths in the interpreter", () => {
		const result = spawnSync(interpretedBinary, [], {
			env: { ...process.env, MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "perf-stats");

		const ic = reportLine(result.stderr, "[perf-ic-stats]");
		expect(field(ic, "load_mono_hits")).toBeGreaterThan(0);
		expect(field(ic, "store_mono_hits")).toBeGreaterThan(0);
		expect(field(ic, "store_slow_mono_hits")).toBe(0);
		expect(field(ic, "load_primitive_hits")).toBeGreaterThan(3000);
		expect(field(ic, "load_string_length_hits")).toBeGreaterThan(1000);
		expect(field(ic, "load_array_length_hits")).toBeGreaterThan(1000);

		const binary = reportLine(result.stderr, "[perf-binary-stats]");
		expect(field(binary, "arithmetic_hits")).toBeGreaterThan(0);
		expect(field(binary, "comparison_hits")).toBeGreaterThan(0);
		expect(field(binary, "bitwise_hits")).toBeGreaterThan(0);
		expect(field(binary, "arithmetic_fallbacks")).toBeGreaterThan(0);

		const interpreter = reportLine(result.stderr, "[perf-interpreter-stats]");
		expect(field(interpreter, "direct_leaf_executions")).toBeGreaterThan(0);
		expect(field(interpreter, "boundary_dispatches")).toBeGreaterThan(0);
		expect(field(interpreter, "state_syncs")).toBeGreaterThanOrEqual(
			field(interpreter, "boundary_dispatches"),
		);
		expect(field(interpreter, "state_reloads")).toBeGreaterThan(0);
		expect(field(interpreter, "normal_helper_continuations")).toBeGreaterThan(0);
		expect(field(interpreter, "strict_direct_hits")).toBeGreaterThan(0);
	});
});
