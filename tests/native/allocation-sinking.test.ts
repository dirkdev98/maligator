import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/allocation-sinking.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-allocation-sinking-"));

describe("fresh allocation sinking", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;
	let programImage: ProgramImage;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "allocation-sinking",
			config: resolveBuildConfig({}),
			outDir,
		});
		({ compiled, interpreted, programImage } = pair);
	}, 600_000);

	it("keeps the numeric vector loop native and specializes locked Math.round", () => {
		const index = programImage.runtime.functions.findIndex(
			(fn) =>
				String.fromCharCode(
					...(programImage.runtime.stringConstants[fn.nameStringIndex] ?? []),
				) === "exercise",
		);
		expect(index).toBeGreaterThanOrEqual(0);
		const fn = programImage.runtime.functions[index]!;
		expect(
			emitCompiledFunction(fn, programImage.native.functions[index]!, index, "", false),
		).not.toBeNull();
		expect(fn.instructions).toContainEqual(
			expect.objectContaining({
				opcode: "MATH_UNARY_NUMBER",
				operation: "Math.round",
			}),
		);
	});

	it("preserves retained identities through both backends and GC stress", () => {
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(
				runToStdout(binary, {
					env: { MAL_HOST_GC: "1", ...STRESS_ENV },
					timeoutMs: 60_000,
				}),
			).toBe(expected);
		}
	});
});
