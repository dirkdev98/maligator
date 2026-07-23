import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-promise-pool-"));
const expected = ["promise-pool PASS"];
const hostGc = { MAL_HOST_GC: "1", MAL_GC_AT_EXIT: "1" };

describe("pooled promise reactions and jobs", () => {
	let compiled: string;
	let interpreted: string;
	let concurrent: string;
	let instrumented: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/promise-pool.js",
			name: "promise-pool",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/promise-pool.js",
			name: "promise-pool-ni",
			compiled: false,
			outDir,
		});
		concurrent = buildNativeBinary({
			fixture: "tests/local/promise-pool.js",
			name: "promise-pool-concurrent",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_GC_CONCURRENT: "1" },
		});
		instrumented = buildNativeBinary({
			fixture: "tests/local/promise-pool.js",
			name: "promise-pool-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	it("preserves pairing, FIFO ordering, and mixed job kinds in compiled code", () => {
		assertExactLines(runToStdout(compiled, { env: hostGc }), expected);
	});

	it("preserves compiled jobs under GC stress", () => {
		assertExactLines(
			runToStdout(compiled, { env: { ...hostGc, ...STRESS_ENV } }),
			expected,
		);
	});

	it("preserves pairing, FIFO ordering, and mixed job kinds in interpreted code", () => {
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("preserves interpreted jobs under GC stress", () => {
		assertExactLines(
			runToStdout(interpreted, { env: { ...hostGc, ...STRESS_ENV } }),
			expected,
		);
	});

	it("preserves slab jobs under concurrent GC", () => {
		assertExactLines(
			runToStdout(concurrent, {
				env: {
					...hostGc,
					...STRESS_ENV,
					MAL_GC_THRESHOLD: "262144",
					MAL_GC_MAJOR_EVERY: "1",
				},
			}),
			expected,
		);
	});

	it("amortizes job allocations and frees every block at teardown", () => {
		const result = spawnSync(instrumented, [], {
			env: { ...process.env, MAL_PERF_STATS: "1", ...hostGc },
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(expected[0]);
		const stat = (field: string) =>
			Number(result.stderr.match(new RegExp(`${field}=(\\d+)`))?.[1] ?? 0);
		const blockAllocations = stat("job_slab_block_allocations");
		expect(blockAllocations).toBeGreaterThan(0);
		expect(stat("job_slab_block_frees")).toBe(blockAllocations);
		expect(stat("job_slab_fresh_slots")).toBeGreaterThan(blockAllocations);
		expect(stat("job_slab_hits")).toBeGreaterThan(0);
		expect(stat("job_slab_peak_retained_bytes")).toBe(6 * 32768);
	});
});
