import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	runToStdout,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

describe("worker isolates", () => {
	for (const compiled of [true, false]) {
		for (const fixture of ["idle-pool", "node-unref", "port-gc"]) {
			it(`${fixture} releases native ownership (${compiled ? "native" : "interpreted"})`, () => {
				const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-worker-ownership-"));
				try {
					const binary = buildNativeBinary({
						fixture: `tests/fixtures/workers-runtime/${fixture}.mjs`,
						name: `worker-${fixture}-${compiled ? "native" : "interpreted"}`,
						outDir,
						compiled,
						nodeEnabled: fixture !== "port-gc",
						...(fixture === "port-gc"
							? { mainFile: "runtime/workers_gc_test_main.c" }
							: {}),
					});
					expect(runToStdout(binary, { timeoutMs: 10_000 })).toBe(`${fixture} PASS\n`);
				} finally {
					rmSync(outDir, { recursive: true, force: true });
				}
			});
		}
	}
	it("terminates spinning and exiting workers uncatchably and bounds standalone channels", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-workers-runtime-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/fixtures/workers-runtime/main.mjs",
				name: "workers-runtime",
				outDir,
				nodeEnabled: true,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(60_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout.trimEnd().split("\n")).toEqual([
				'channel: ["number",true,"RangeError",false,true,false,"number",["b","d"],false]',
				'spin: ["terminated",1,true,true]',
				'exit: ["completed",7,[]]',
				'startup: ["startup boom","error",1]',
			]);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	it("validates transferred ports after getters and releases abandoned channels", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-workers-transport-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/fixtures/workers-runtime/transport.mjs",
				name: "workers-transport",
				outDir,
				nodeEnabled: true,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(60_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout.trimEnd().split("\n")).toEqual([
				'getter-close: ["DataCloneError",8,true]',
				'getter-retransfer: ["DataCloneError",8,true,"moved"]',
				'roundtrip: ["DataCloneError","through",true,true,true]',
				"abandoned: [true]",
			]);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	it("settles ready after top-level await and fails startup on rejected or unsettled evaluation", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-workers-tla-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/fixtures/workers-runtime/tla.mjs",
				name: "workers-tla",
				outDir,
				nodeEnabled: true,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(60_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout.trimEnd().split("\n")).toEqual([
				'tla-ok: [1,"completed",0]',
				'tla-reject: ["tla boom","error",1,"tla boom",1,"error","tla boom",true]',
				'tla-undefined: [true,"error",true,true]',
				'tla-pending: [true,"error",1]',
			]);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	it("shares a process queue limit, keeps buffers when a getter closes the channel, and rejects uncloneable objects", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-workers-admission-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/fixtures/workers-runtime/admission.mjs",
				name: "workers-admission",
				outDir,
				nodeEnabled: true,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(60_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout.trimEnd().split("\n")).toEqual([
				'process-limit: [65536,"RangeError",0,"posted",65536]',
				'getter-close-queue: ["posted",8,true,"posted",8,true]',
				'uncloneable: ["DataCloneError","posted",true,1,true]',
			]);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});
