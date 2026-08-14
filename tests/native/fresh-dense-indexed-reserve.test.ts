import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/fresh-dense-indexed-reserve.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-fresh-dense-indexed-reserve-"));

function run(binary: string, env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...env },
		encoding: "utf-8",
		timeout: 60_000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, "fresh-dense-indexed-reserve");
	return result.stderr;
}

function field(stderr: string, name: string): number {
	const line = stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-array-stats]"));
	return Number(line?.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("fresh canonical indexed Array reserve", () => {
	let compiled: string;
	let interpreted: string;
	let instrumented: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "fresh-dense-indexed-reserve",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "fresh-dense-indexed-reserve-ni",
			compiled: false,
			outDir,
		});
		instrumented = buildNativeBinary({
			fixture,
			name: "fresh-dense-indexed-reserve-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	}, 600_000);

	it("preserves identity, values, and inherited indexed setters", () => {
		run(compiled);
		run(interpreted);
	});

	it("keeps the pre-reserved vector correct under GC stress", () => {
		run(compiled, { ...STRESS_ENV, MAL_HOST_GC: "1" });
	});

	it("reports exact reserves, savings, and poisoned-prototype fallback", () => {
		const stderr = run(instrumented, { MAL_PERF_STATS: "1" });
		expect(field(stderr, "indexed_fill_reserves")).toBe(2);
		expect(field(stderr, "indexed_fill_reserved_slots")).toBe(32);
		expect(field(stderr, "indexed_fill_allocations_avoided")).toBe(4);
		expect(field(stderr, "indexed_fill_raw_bytes_avoided")).toBe(192);
		expect(field(stderr, "indexed_fill_guard_fallbacks")).toBe(1);
	});
});
