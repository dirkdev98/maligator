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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-compiled-call-cache-family-"));
const fixture = "tests/local/compiled-call-cache-family.js";
const expected = ["compiled-call-cache-family PASS"];

function strictField(line: string, name: string): number {
	const match = line.match(new RegExp(`(?:^|\\s)${name}=([0-9]+)(?:\\s|$)`));
	if (match === null) throw new Error(`missing counter ${name}: ${line}`);
	return Number(match[1]);
}

function callCacheReport(stderr: string): string {
	const line = stderr
		.split("\n")
		.find((candidate) => candidate.startsWith("[perf-call-cache-stats]"));
	if (line === undefined) throw new Error(`missing call-cache report:\n${stderr}`);
	return line;
}

describe("compiled call dispatch and native call caches", () => {
	let instrumented: string;
	let multiVm: string;

	beforeAll(() => {
		instrumented = buildNativeBinary({
			fixture,
			name: "compiled-call-cache-family",
			compiled: true,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		});
		multiVm = buildNativeBinary({
			fixture,
			name: "compiled-call-cache-family-multi-vm",
			compiled: true,
			mainFile: "runtime/call_cache_test_main.c",
			outDir,
		});
	}, 600_000);

	it("uses current captures, callee, and this for every fresh closure", () => {
		assertExactLines(runToStdout(instrumented, { env: { MAL_HOST_GC: "1" } }), expected);
	});

	it("keeps unrooted family hints safe across GC epochs", () => {
		assertExactLines(
			runToStdout(instrumented, {
				env: { MAL_HOST_GC: "1", ...STRESS_ENV },
				timeoutMs: 60_000,
			}),
			expected,
		);
	});

	it("does not reuse exact identities across sequential VMs", () => {
		assertExactLines(runToStdout(multiVm, { env: { MAL_HOST_GC: "1" } }), [
			...expected,
			...expected,
		]);
	});

	it("reports direct compiled dispatch and exact native cache mechanisms", () => {
		const result = spawnSync(instrumented, [], {
			env: { ...process.env, MAL_HOST_GC: "1", MAL_PERF_STATS: "1" },
			encoding: "utf-8",
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		assertExactLines(result.stdout, expected);

		const report = callCacheReport(result.stderr);
		const probes = strictField(report, "probes");
		const exactHits = strictField(report, "exact_identity_hits");
		const compiledDispatches = strictField(report, "compiled_dispatches");
		const nativeExactHits = strictField(report, "native_exact_hits");
		const wayChecks = strictField(report, "way_checks");
		const misses = strictField(report, "dispatch_misses");
		const nativeFills = strictField(report, "native_fills");

		expect(exactHits).toBeGreaterThan(0);
		expect(compiledDispatches).toBeGreaterThan(150);
		expect(nativeExactHits).toBeGreaterThan(0);
		expect(nativeExactHits).toBe(exactHits);
		expect(wayChecks).toBeGreaterThanOrEqual(nativeExactHits);
		expect(misses).toBeGreaterThan(0);
		expect(nativeFills).toBeGreaterThan(0);
		expect(compiledDispatches + nativeExactHits + misses).toBe(probes);
		expect(nativeFills).toBeLessThanOrEqual(misses);
	});
});
