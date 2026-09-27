import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

describe("concurrent environment tracing", () => {
	it("drains a discovered Env chain and preserves mutation while a descendant is paused", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-concurrent-drain-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-concurrent-drain",
				mainFile: "tests/fixtures/gc-concurrent-drain/main.c",
				outDir,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_MAJOR_EVERY: "1",
					MAL_GC_VERIFY: "1",
					MAL_GC_STATS: "1",
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("gc-concurrent-drain PASS\n");
			expect(
				Number(result.stderr.match(/\bconcurrent_drain_traces=(\d+)/)?.[1] ?? 0),
			).toBeGreaterThan(0);
			expect(
				Number(result.stderr.match(/\bconcurrent_drain_limit_hits=(\d+)/)?.[1] ?? 0),
			).toBeGreaterThan(0);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	it("retains an overwritten edge and joins an active worker at teardown", (ctx) => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-overlap-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-overlap",
				mainFile: "tests/fixtures/gc-overlap/main.c",
				outDir,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_MAJOR_EVERY: "1",
					MAL_GC_VERIFY: "1",
					MAL_GC_STATS: "1",
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			if (result.stdout === "gc-overlap SKIP\n") {
				expect(result.stderr).toMatch(/\bworker_limit=0\b/);
				ctx.skip("GC workers unavailable at this CPU capacity");
			}
			expect(result.stdout).toBe("gc-overlap PASS\n");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	it("retains a suspended generator's frame snapshot across worker overlap", (ctx) => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-generator-overlap-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/gc-generator-overlap.js",
				name: "gc-generator-overlap",
				mainFile: "tests/fixtures/gc-generator-overlap/main.c",
				outDir,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_MAJOR_EVERY: "1",
					MAL_GC_VERIFY: "1",
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			if (result.stdout === "gc-generator-overlap SKIP\n") {
				ctx.skip("GC workers unavailable at this CPU capacity");
			}
			expect(result.stdout).toBe("gc-generator-overlap PASS\n");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
