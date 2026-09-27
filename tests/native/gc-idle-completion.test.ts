import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseProfileCapture } from "../../src/profile-artifact.ts";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

describe("GC idle completion", () => {
	it("finishes before idle without repeating idle notification or waiting for reactor work", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-idle-completion-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-idle-completion",
				mainFile: "tests/fixtures/gc-idle-completion/main.c",
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
			expect(result.status, result.signal || result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("gc-idle-completion PASS\n");
			expect(result.stderr).toMatch(/\bcollections=2 minor=0 major=2 pauses=3\b/);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	it("records complete, unnested pauses across automatic and explicit major work", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-idle-profile-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-idle-profile",
				mainFile: "tests/fixtures/gc-idle-completion/main.c",
				profileEnabled: true,
				outDir,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const capture = path.join(outDir, "capture.bin");
			const result = spawnSync(invocation.executable, invocation.args, {
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_MAJOR_EVERY: "1",
					MAL_PROFILE_CAPTURE: capture,
					MAL_PROFILE_IDENTITY: "a".repeat(64),
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.signal || result.stderr || result.stdout).toBe(0);
			const records = parseProfileCapture(readFileSync(capture)).records.filter(
				(record) => record.kind === 3 || record.kind === 4,
			);
			expect(records.map((record) => [record.kind, record.value])).toEqual([
				[3, 1],
				[4, 1],
				[3, 1],
				[4, 1],
				[3, 1],
				[4, 1],
			]);
			for (let i = 0; i < records.length; i += 2) {
				expect(records[i + 1]!.timestampNs).toBeGreaterThanOrEqual(
					records[i]!.timestampNs,
				);
			}
			const incremental = spawnSync(invocation.executable, [...invocation.args, "0"], {
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_MAJOR_EVERY: "1",
					MAL_PROFILE_CAPTURE: capture,
					MAL_PROFILE_IDENTITY: "a".repeat(64),
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (incremental.error !== undefined) throw incremental.error;
			expect(incremental.status, incremental.signal || incremental.stderr).toBe(0);
			const incrementalPauses = parseProfileCapture(readFileSync(capture)).records.filter(
				(record) => record.kind === 3 || record.kind === 4,
			);
			expect(incrementalPauses.map((record) => record.kind)).toEqual([
				3, 4, 3, 4, 3, 4, 3, 4,
			]);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
