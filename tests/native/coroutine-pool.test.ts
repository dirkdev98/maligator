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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-coroutine-pool-"));
const expected = ["coroutine-pool PASS"];
const retentionExpected = ["coroutine-pool-retention PASS"];
const hostGc = { MAL_HOST_GC: "1" };

interface CoroutineStats {
	requests: number;
	allocations: number;
	reuses: number;
	releases: number;
	pooled: number;
	dropped: number;
	peakRetainedBytes: number;
}

function runWithStats(binary: string, expectedLines = expected): CoroutineStats {
	const result = spawnSync(binary, [], {
		env: {
			...process.env,
			...hostGc,
			MAL_GC_STATS: "1",
			MAL_COROUTINE_STATS: "1",
		},
		encoding: "utf-8",
		timeout: 20_000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr).toBe(0);
	assertExactLines(result.stdout, expectedLines);
	const line = result.stderr
		.split("\n")
		.find((candidate) => candidate.includes("[coroutine-stats]"));
	expect(line).toBeDefined();
	const stat = (field: string): number => {
		const match = line?.match(new RegExp(`${field}=([0-9]+)`));
		expect(match, `missing ${field} in ${line}`).not.toBeNull();
		return Number(match?.[1]);
	};
	return {
		requests: stat("requests"),
		allocations: stat("allocations"),
		reuses: stat("reuses"),
		releases: stat("releases"),
		pooled: stat("pooled"),
		dropped: stat("dropped"),
		peakRetainedBytes: stat("peak_retained_bytes"),
	};
}

function assertBoundedPool(stats: CoroutineStats): void {
	expect(stats.requests).toBe(stats.allocations + stats.reuses);
	expect(stats.releases).toBe(stats.pooled + stats.dropped);
	expect(stats.peakRetainedBytes).toBeGreaterThan(0);
	expect(stats.peakRetainedBytes).toBeLessThanOrEqual(1024 * 1024);
}

describe("pooled suspendable-frame support", () => {
	let compiled: string;
	let interpreted: string;
	let retentionCompiled: string;
	let retentionInterpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/coroutine-pool.js",
			name: "coroutine-pool",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/coroutine-pool.js",
			name: "coroutine-pool-ni",
			compiled: false,
			outDir,
		});
		retentionCompiled = buildNativeBinary({
			fixture: "tests/local/coroutine-pool-retention.js",
			name: "coroutine-pool-retention",
			compiled: true,
			outDir,
		});
		retentionInterpreted = buildNativeBinary({
			fixture: "tests/local/coroutine-pool-retention.js",
			name: "coroutine-pool-retention-ni",
			compiled: false,
			outDir,
		});
	});

	it.each([
		["compiled", () => retentionCompiled],
		["interpreted", () => retentionInterpreted],
	] as const)("reuses a GC-finalized batch of small %s frames", (_name, binary) => {
		const stats = runWithStats(binary(), retentionExpected);
		assertBoundedPool(stats);
		expect(stats.reuses).toBeGreaterThanOrEqual(4000);
	});

	it("reuses compiled frames and preserves queued async-generator requests", () => {
		assertBoundedPool(runWithStats(compiled));
	});

	it("preserves compiled support nodes under GC stress", () => {
		assertExactLines(
			runToStdout(compiled, { env: { ...hostGc, ...STRESS_ENV } }),
			expected,
		);
	});

	it("reuses interpreted register/argument buffers and preserves request order", () => {
		const stats = runWithStats(interpreted);
		assertBoundedPool(stats);
		expect(stats.dropped).toBeGreaterThanOrEqual(4);
	});

	it("preserves interpreted support nodes under GC stress", () => {
		assertExactLines(
			runToStdout(interpreted, { env: { ...hostGc, ...STRESS_ENV } }),
			expected,
		);
	});
});
