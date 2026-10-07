import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitProgramTranslationUnits } from "../../src/compiler/target/emit-program-image.ts";
import { buildLocalBinary } from "../../src/local-build.ts";
import {
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("polling numeric C workers", () => {
	it("preserves IEEE results, caller roots, sticky termination and activation balance with and without observation tables", () => {
		const fixture = "tests/local/native-numeric-workers.js";
		const outDir = mkdtempSync(join(tmpdir(), "mal-numeric-workers-"));
		try {
			const expected = `${execFileSync(process.execPath, [fixture], { encoding: "utf8" })}numeric-worker-termination PASS\n`;
			const built = buildNativeBinaryResult({
				fixture,
				name: "numeric-workers-observed",
				mainFile: "runtime/numeric_worker_test_main.c",
				outDir,
				config: resolveBuildConfig({}),
			});
			for (const name of [
				"numericWorkerLoop",
				"numericWorkerCollatz",
				"numericWorkerSpin",
			]) {
				const native = built.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(built.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(native).toBeDefined();
				expect(
					native.directEntries.some(
						(entry) => (entry.storage!.numericWorker?.pollingIps.length ?? 0) > 0,
					),
				).toBe(true);
			}
			const functions = new Map(
				built.programImage.native.functions.map((fn) => [
					String.fromCharCode(
						...(built.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
							[]),
					),
					fn,
				]),
			);
			const spin = functions.get("numericWorkerSpin")!;
			const caller = functions.get("numericWorkerSpinCaller")!;
			const calls = caller.storage!.callTransports;
			expect(calls).toHaveLength(1);
			expect(calls[0]!.targets).toHaveLength(1);
			const target = calls[0]!.targets[0]!;
			expect(target.functionIndex).toBe(spin.functionIndex);
			expect(
				spin.directEntries[target.entryId]!.storage!.numericWorker!.pollingIps.length,
			).toBeGreaterThan(0);
			const source = emitProgramTranslationUnits(built.programImage, {
				compiled: true,
				debugInfo: false,
			});
			const emitted = source.map((unit) => unit.source).join("\n");
			expect(emitted).toContain(`mal_direct_${spin.functionIndex}_${target.entryId}(vm,`);
			expect(emitted).toMatch(/mal_direct_\d+_\d+_worker\(MalVm \*vm/);
			const unobserved = buildLocalBinary({
				context: built.context,
				name: "numeric-workers-unobserved",
				cSource: source,
				verbose: false,
				outDir,
				mainFile: "runtime/numeric_worker_test_main.c",
			});
			for (const binary of [built.binaryPath, unobserved.binaryPath]) {
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 600_000);
});
