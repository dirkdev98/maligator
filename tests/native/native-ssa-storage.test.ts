import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/native-ssa-storage.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-native-ssa-storage-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("independent native suspension storage", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;
	let image: ProgramImage;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "native-ssa-storage",
			mainFile: HOST_MAIN,
			outDir,
		});
		({ compiled, interpreted, programImage: image } = pair);
	}, 600_000);

	it("traces heap locals beyond the VM frame through yield, throw, finally, and await", () => {
		const suspended = image.native.functions.filter((fn) => fn.mode === "resumable");
		expect(suspended.length).toBeGreaterThanOrEqual(2);
		for (const fn of suspended) {
			const vm = image.runtime.functions[fn.functionIndex]!;
			const vmCount = vm.registerCount;
			expect(emitCompiledFunction(vm, fn, fn.functionIndex, "", false)).not.toBeNull();
			expect(
				fn.gc.safepoints.some((point) => {
					const op = fn.body.instructions[point.instructionIp];
					return (
						(op?.opcode === "YIELD" || op?.opcode === "AWAIT") &&
						point.rootRegisters.some((local) => local >= vmCount)
					);
				}),
			).toBe(true);
		}
		for (const binary of [compiled, interpreted]) {
			for (const stress of [{}, STRESS_ENV]) {
				expect(
					runToStdout(binary, {
						env: { ...stress, MAL_HOST_GC: "1" },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
			}
		}
	});
});
