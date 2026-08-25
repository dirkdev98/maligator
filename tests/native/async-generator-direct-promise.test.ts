import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-async-generator-direct-promise-"));
const expected = "async-generator-direct-promise PASS";

function run(binary: string, env: NodeJS.ProcessEnv = {}, timeout = 120_000): string {
	const result = spawnSync(binary, [], {
		env: { ...process.env, MAL_HOST_GC: "1", ...env },
		encoding: "utf8",
		timeout,
	});
	if (result.error !== undefined) throw result.error;
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout.trim()).toBe(expected);
	expect(result.stderr).toContain(
		"Uncaught (in promise) Error: async-generator-direct-unhandled-marker",
	);
	return result.stderr;
}

describe("direct async-generator request Promises", () => {
	let compiled: string;
	let interpreted: string;
	let concurrent: string;
	let instrumented: string;
	let poolOverflow: string;
	let crossRealm: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/async-generator-direct-promise.js",
			name: "async-generator-direct-promise",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/async-generator-direct-promise.js",
			name: "async-generator-direct-promise-ni",
			compiled: false,
			outDir,
		});
		concurrent = buildNativeBinary({
			fixture: "tests/local/async-generator-direct-promise.js",
			name: "async-generator-direct-promise-concurrent",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_GC_CONCURRENT: "1" },
		});
		instrumented = buildNativeBinary({
			fixture: "tests/local/async-generator-direct-promise.js",
			name: "async-generator-direct-promise-perf",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		poolOverflow = buildNativeBinary({
			fixture: "tests/local/async-generator-request-pool-overflow.js",
			name: "async-generator-request-pool-overflow",
			compiled: true,
			outDir,
		});
		crossRealm = buildNativeBinary({
			fixture: "tests/local/async-generator-cross-realm-request.js",
			name: "async-generator-cross-realm-request",
			compiled: true,
			mainFile: "runtime/test262_main.c",
			outDir,
			realmsEnabled: true,
		});
	});

	it.each([
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	] as const)("preserves %s request behavior", (_name, binary) => {
		run(binary());
	});

	it.each([
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	] as const)(
		"retains pending %s requests under GC stress",
		(_name, binary) => {
			// The interpreted verifier takes about 160s on current arm64 hosts.
			run(binary(), STRESS_ENV, 240_000);
		},
		250_000,
	);

	it("retains pending requests under concurrent GC", () => {
		run(concurrent, {
			...STRESS_ENV,
			MAL_GC_THRESHOLD: "262144",
			MAL_GC_MAJOR_EVERY: "1",
		});
	});

	it("reports direct requests without per-request callback pairs", () => {
		const stderr = run(instrumented, { MAL_PERF_STATS: "1" });
		const direct = Number(
			stderr.match(/async_generator_direct_requests=(\d+)/)?.[1] ?? 0,
		);
		const pairs = Number(stderr.match(/resolving_pairs=(\d+)/)?.[1] ?? 0);
		expect(direct).toBeGreaterThan(0);
		expect(pairs).toBeLessThan(direct);
	});

	it("caps and reuses the request pool after an overflow batch", () => {
		const result = spawnSync(poolOverflow, [], {
			env: { ...process.env, MAL_GC_STATS: "1", MAL_PROMISE_STATS: "1" },
			encoding: "utf8",
			timeout: 60_000,
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("async-generator-request-pool-overflow PASS");
		const allocations = Number(
			result.stderr.match(/request_allocations=(\d+)/)?.[1] ?? 0,
		);
		const reuses = Number(result.stderr.match(/request_reuses=(\d+)/)?.[1] ?? 0);
		expect(allocations).toBe(4132);
		expect(reuses).toBe(4096);
	});

	it("retains the request Promise realm while a foreign generator resumes", () => {
		const result = spawnSync(crossRealm, [], {
			env: { ...process.env, MAL_TEST262: "1" },
			encoding: "utf8",
			timeout: 60_000,
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("async-generator-cross-realm-request PASS");
	});
});
