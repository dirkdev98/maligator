import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertPassLine, buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-private-aggregate-memo-"));

function run(binary: string, env: NodeJS.ProcessEnv = {}): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...env },
		encoding: "utf-8",
		timeout: 60000,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr || result.stdout).toBe(0);
	assertPassLine(result.stdout, "private-aggregate-memo");
	return result.stderr;
}

function field(stderr: string, name: string): number {
	const line = stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-private-aggregate-memo-stats]"));
	return Number(line?.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)`))?.[1] ?? 0);
}

describe("activation-local private aggregate result memo", () => {
	let compiled: string;
	let interpreted: string;
	let instrumented: string;
	let guards: string;
	let small: string;
	let smallConcurrent: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/private-aggregate-memo.js",
			name: "private-aggregate-memo",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/private-aggregate-memo.js",
			name: "private-aggregate-memo-ni",
			compiled: false,
			outDir,
		});
		instrumented = buildNativeBinary({
			fixture: "tests/local/private-aggregate-memo.js",
			name: "private-aggregate-memo-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		guards = buildNativeBinary({
			fixture: "tests/local/private-aggregate-memo-guards.js",
			name: "private-aggregate-memo-guards",
			compiled: true,
			outDir,
		});
		small = buildNativeBinary({
			fixture: "tests/local/private-aggregate-memo-small.js",
			name: "private-aggregate-memo-small",
			compiled: true,
			outDir,
		});
		smallConcurrent = buildNativeBinary({
			fixture: "tests/local/private-aggregate-memo-small.js",
			name: "private-aggregate-memo-small-concurrent",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_GC_CONCURRENT: "1" },
		});
	});

	it("preserves compiled and interpreted semantics", () => {
		run(compiled);
		run(interpreted);
	});

	it("keeps activation roots valid under stress and concurrent collection", () => {
		const result = spawnSync(small, [], {
			env: { ...process.env, ...STRESS_ENV, MAL_HOST_GC: "1" },
			encoding: "utf-8",
			timeout: 60000,
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "private-aggregate-memo-small");
		const concurrentResult = spawnSync(smallConcurrent, [], {
			env: { ...process.env, ...STRESS_ENV, MAL_HOST_GC: "1" },
			encoding: "utf-8",
			timeout: 60000,
		});
		expect(
			concurrentResult.status,
			concurrentResult.stderr || concurrentResult.stdout,
		).toBe(0);
		assertPassLine(concurrentResult.stdout, "private-aggregate-memo-small");
	});

	it("falls back when Array iterator next is patched", () => {
		const result = spawnSync(guards, [], { encoding: "utf-8", timeout: 60000 });
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertPassLine(result.stdout, "private-aggregate-memo-guards");
	});

	it("reports one ordinary fill and later activation-local hits", () => {
		const stderr = run(instrumented, { MAL_PERF_STATS: "1" });
		expect(field(stderr, "candidates")).toBe(3000);
		expect(field(stderr, "fills")).toBe(2);
		expect(field(stderr, "hits")).toBe(2998);
		expect(field(stderr, "misses")).toBe(2);
		expect(field(stderr, "calls_elided")).toBe(2998);
		expect(field(stderr, "guard_fallbacks")).toBe(0);
	});
});
