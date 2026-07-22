import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-promise-direct-capability-"));
const expected = "promise-direct-capability PASS";

function run(binary: string, env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(binary, [], {
		env: { ...process.env, ...env },
		encoding: "utf8",
		timeout: 60000,
	});
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`binary exited ${result.status ?? "without status"}\n${result.stdout}\n${result.stderr}`,
		);
	}
	if (result.stdout.trim() !== expected) {
		throw new Error(
			`unexpected output\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
		);
	}
	expect(result.stderr).toContain("Uncaught (in promise) Error: direct-unhandled-marker");
	expect(result.stderr).toContain(
		"Uncaught (in promise) Error: direct-intrinsic-unhandled-marker",
	);
	expect(result.stderr).toContain(
		"Uncaught (in promise) Error: direct-async-unhandled-marker",
	);
	return result.stderr;
}

describe("direct Promise.prototype.then capabilities", () => {
	let compiled: string;
	let interpreted: string;
	let concurrent: string;
	let instrumented: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/promise-direct-capability.js",
			name: "promise-direct-capability",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/promise-direct-capability.js",
			name: "promise-direct-capability-ni",
			compiled: false,
			outDir,
		});
		concurrent = buildNativeBinary({
			fixture: "tests/local/promise-direct-capability.js",
			name: "promise-direct-capability-concurrent",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_GC_CONCURRENT: "1" },
		});
		instrumented = buildNativeBinary({
			fixture: "tests/local/promise-direct-capability.js",
			name: "promise-direct-capability-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
	});

	it("preserves exact and generic capability semantics in compiled code", () => {
		run(compiled);
	});

	it("preserves active jobs and fallback pairs under compiled GC stress", () => {
		run(compiled, { ...STRESS_ENV, MAL_HOST_GC: "1" });
	});

	it("preserves capability semantics in interpreted code", () => {
		run(interpreted);
	});

	it("preserves interpreted jobs and reactions under GC stress", () => {
		run(interpreted, { ...STRESS_ENV, MAL_HOST_GC: "1" });
	});

	it("preserves direct targets under concurrent GC", () => {
		run(concurrent, {
			...STRESS_ENV,
			MAL_HOST_GC: "1",
			MAL_GC_THRESHOLD: "262144",
			MAL_GC_MAJOR_EVERY: "1",
		});
	});

	it("reports direct capabilities and lazy fallback materialization", () => {
		const stderr = run(compiled, {
			MAL_GC_STATS: "1",
			MAL_PROMISE_STATS: "1",
		});
		const direct = Number(stderr.match(/direct_capabilities=(\d+)/)?.[1] ?? 0);
		const fallback = Number(stderr.match(/materialized_fallback_pairs=(\d+)/)?.[1] ?? 0);
		const intrinsic = Number(stderr.match(/direct_intrinsic_creations=(\d+)/)?.[1] ?? 0);
		const asyncResults = Number(stderr.match(/direct_async_results=(\d+)/)?.[1] ?? 0);
		expect(direct).toBeGreaterThan(0);
		expect(fallback).toBeGreaterThan(0);
		expect(fallback).toBeLessThan(direct);
		expect(intrinsic).toBeGreaterThan(0);
		expect(asyncResults).toBeGreaterThan(0);
	});

	it("reports typed await continuations and jobs", () => {
		const stderr = run(instrumented, { MAL_PERF_STATS: "1" });
		const continuations = Number(
			stderr.match(/await_typed_continuations=(\d+)/)?.[1] ?? 0,
		);
		const jobs = Number(stderr.match(/await_typed_jobs=(\d+)/)?.[1] ?? 0);
		expect(continuations).toBeGreaterThan(0);
		expect(jobs).toBe(continuations);
	});
});
