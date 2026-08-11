import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-stack-object-"));

function field(line: string, name: string): number {
	return Number(line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("compiled stack objects", () => {
	let compiled: string;
	let compiledPerf: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/stack-object.js",
			name: "stack-object",
			compiled: true,
			outDir,
		});
		compiledPerf = buildNativeBinary({
			fixture: "tests/local/stack-object.js",
			name: "stack-object-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/stack-object.js",
			name: "stack-object-ni",
			compiled: false,
			outDir,
		});
	});

	it("preserves compiled identity, slots, recursion, branches, materialization, and escapes", () => {
		assertPassLine(
			runToStdout(compiled, { env: { MAL_ALLOC_FAIL_TEST: "1" } }),
			"stack-object",
		);
	});

	it("keeps stack slots rooted under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertPassLine(
			runToStdout(compiled, {
				env: { ...STRESS_ENV, MAL_ALLOC_FAIL_TEST: "1" },
				timeoutMs: 60000,
			}),
			"stack-object",
		);
	});

	it("takes exact inherited-island cold, mutation, accessor, and stable paths", () => {
		const result = spawnSync(compiledPerf, [], {
			env: { ...process.env, MAL_PERF_STATS: "1", MAL_ALLOC_FAIL_TEST: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "stack-object");
		const line = result.stderr
			.split("\n")
			.find((candidate) => candidate.startsWith("[perf-allocation-stats]"));
		expect(line).toBeDefined();
		expect(field(line ?? "", "stack_inherited_fast")).toBe(3);
		expect(field(line ?? "", "stack_inherited_heap_fallbacks")).toBe(5);
		expect(field(line ?? "", "stack_inherited_direct_loads")).toBe(3);
	});

	it("retains interpreted semantic parity", () => {
		assertPassLine(runToStdout(interpreted), "stack-object");
	});
});
