import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	nativePrivateCallResultIps,
	nativePrivateRootRegisters,
} from "../../src/compiler/target/lower-native-root-publication.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildNativeBinary,
	buildNativeBinaryResult,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
} from "../../src/test-harness.ts";

describe("concurrent object edge snapshots", () => {
	for (const spec of [
		{
			name: "gc-snapshot-overlap",
			mainFile: "tests/fixtures/gc-snapshot-overlap/main.c",
			intent: "retains copied dense edges across overwrite, delete, and resize",
			args: [],
			pointerValues: false,
		},
		{
			name: "gc-snapshot-object",
			mainFile: "tests/fixtures/gc-snapshot-object/main.c",
			intent: "filters primitive values from shaped snapshots while retaining edges",
			args: [],
			pointerValues: false,
		},
		{
			name: "gc-snapshot-object",
			mainFile: "tests/fixtures/gc-snapshot-object/main.c",
			intent: "copies pointer-heavy shaped records with shared values",
			args: ["pointer"],
			pointerValues: true,
		},
	])
		it(spec.intent, (ctx) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-snapshot-overlap-"));
			try {
				const binary = buildNativeBinary({
					fixture: "tests/local/fibertest_stub.js",
					name: spec.name,
					mainFile: spec.mainFile,
					outDir,
				});
				const invocation = resolveHarnessExecutionInvocation(binary);
				const result = spawnSync(
					invocation.executable,
					[...invocation.args, ...spec.args],
					{
						env: {
							...process.env,
							MAL_GC_STRESS: "0",
							MAL_GC_VERIFY: "1",
							MAL_GC_STATS: "1",
						},
						encoding: "utf8",
						timeout: scaledNativeRunTimeoutMs(120_000),
					},
				);
				if (result.error !== undefined) throw result.error;
				expect(result.status, result.stderr || result.stdout).toBe(0);
				if (result.stdout === `${spec.name} SKIP\n`) {
					expect(result.stderr).toMatch(/\bworker_limit=0\b/);
					ctx.skip("GC workers unavailable at this CPU capacity");
				}
				expect(result.stdout).toBe(`${spec.name} PASS\n`);
				expect(
					Number(result.stderr.match(/\bsnapshot_discoveries=(\d+)/)?.[1] ?? 0),
				).toBeGreaterThan(0);
				if (spec.name === "gc-snapshot-object") {
					const examined = Number(
						result.stderr.match(/\bsnapshot_examined_values=(\d+)/)?.[1] ?? 0,
					);
					const copied = Number(result.stderr.match(/\bsnapshot_values=(\d+)/)?.[1] ?? 0);
					expect(copied).toBeLessThanOrEqual(examined);
					if (spec.pointerValues) {
						expect(examined).toBeGreaterThan(0);
						expect(copied / examined).toBeGreaterThan(0.9);
					} else {
						expect(examined).toBeGreaterThan(copied);
					}
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		});
});

describe("dense array fill barriers", () => {
	it("remembers one young value across a filled range in an old array", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-dense-fill-card-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "gc-dense-fill-card",
				mainFile: "tests/fixtures/gc-dense-fill-card/main.c",
				outDir,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_MAJOR_EVERY: "8",
					MAL_GC_VERIFY: "1",
					MAL_GC_STATS: "1",
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe("gc-dense-fill-card PASS\n");
			expect(Number(result.stderr.match(/\bminor=(\d+)/)?.[1] ?? 0)).toBeGreaterThan(0);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
});

describe("compiled roots during a concurrent object snapshot", () => {
	it("preserves property-region fallback and publishes a private native call result at the worker poll", (ctx) => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-compiled-worker-"));
		try {
			const build = buildNativeBinaryResult({
				fixture: "tests/local/gc-compiled-worker-boundary.js",
				name: "gc-compiled-worker-boundary",
				mainFile: "tests/fixtures/gc-compiled-worker-boundary/main.c",
				outDir,
			});
			const image = build.programImage;
			const regionIndex = image.runtime.functions.findIndex(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
					) === "readRegion",
			);
			expect(regionIndex).toBeGreaterThanOrEqual(0);
			const regionSource = emitCompiledFunction(
				image.runtime.functions[regionIndex]!,
				image.native.functions[regionIndex]!,
				regionIndex,
				"",
				false,
			)?.source;
			expect(regionSource).toContain("mal_vm_property_read_region_begin(");
			expect(regionSource?.match(/mal_vm_property_read_region_try_load\(/g)).toHaveLength(
				3,
			);
			const getterIndex = image.runtime.functions.findIndex(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
					) === "readReturnedToken",
			);
			expect(getterIndex).toBeGreaterThanOrEqual(0);
			const fn = image.runtime.functions[getterIndex]!;
			const native = image.native.functions[getterIndex]!;
			const privateCalls = nativePrivateCallResultIps(fn, native);
			const frameRegisters = new Set(
				native.gc.safepoints.flatMap((point) => point.rootRegisters),
			);
			const privateRegisters = nativePrivateRootRegisters(
				fn,
				native,
				frameRegisters,
				privateCalls,
			);
			const calls = fn.instructions.flatMap((instruction, ip) =>
				instruction.opcode === "CALL" ? [{ instruction, ip }] : [],
			);
			expect(calls).toHaveLength(1);
			const call = calls[0]!;
			expect(privateCalls.has(call.ip)).toBe(true);
			expect(privateRegisters.has(call.instruction.dst)).toBe(true);
			expect(
				native.gc.safepoints.find((point) => point.instructionIp === call.ip)
					?.outgoingRootRegisters,
			).toContain(call.instruction.dst);
			const invocation = resolveHarnessExecutionInvocation(build.binaryPath);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: {
					...process.env,
					MAL_GC_STRESS: "0",
					MAL_GC_VERIFY: "1",
					MAL_GC_STATS: "1",
				},
				encoding: "utf8",
				timeout: scaledNativeRunTimeoutMs(120_000),
			});
			if (result.error !== undefined) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			if (result.stdout === "gc-compiled-worker-boundary SKIP\n") {
				expect(result.stderr).toMatch(/\bworker_limit=0\b/);
				ctx.skip("GC workers unavailable at this CPU capacity");
			}
			expect(result.stdout).toBe("gc-compiled-worker-boundary PASS\n");
			expect(
				Number(result.stderr.match(/\bsnapshot_discoveries=(\d+)/)?.[1] ?? 0),
			).toBeGreaterThan(0);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 600_000);
});
