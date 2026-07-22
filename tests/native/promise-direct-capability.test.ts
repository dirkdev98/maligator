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
	return result.stderr;
}

describe("direct Promise.prototype.then capabilities", () => {
	let compiled: string;
	let interpreted: string;
	let concurrent: string;

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
		expect(direct).toBeGreaterThan(0);
		expect(fallback).toBeGreaterThan(0);
		expect(fallback).toBeLessThan(direct);
	});
});
