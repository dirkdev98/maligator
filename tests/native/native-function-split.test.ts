import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/native-function-split.js";
// Small enough that every large fixture function splits into nested and packed parts.
const policy = { thresholdCodeUnits: 1024, partCodeUnits: 1024 };
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-native-function-split-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function functionNamed(image: ProgramImage, name: string) {
	const native = image.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === name,
	);
	if (native === undefined) throw new Error(`fixture lacks ${name}`);
	return native;
}

describe("outlined native function parts", () => {
	let expected: string;
	let binary: string;
	let image: ProgramImage;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const result = buildNativeBinaryResult({
			fixture,
			name: "native-function-split",
			compiled: true,
			outDir,
			nativeFunctionSplit: policy,
		});
		binary = result.binaryPath;
		image = result.programImage;
	}, 600_000);

	it("outlines each large fixture function", () => {
		for (const name of ["interpret", "classify", "survey"]) {
			const native = functionNamed(image, name);
			const emitted = emitCompiledFunction(
				native,
				native.functionIndex,
				"",
				true,
				"static",
				new Set(),
				image.native.semanticProtectors,
				new Map(),
				false,
				new Set(),
				image.runtime.stringConstants,
				new Set(),
				Infinity,
				policy,
			);
			expect(emitted?.source).toContain(`${emitted!.symbol}_part_1(MalVm *vm`);
		}
	});

	it("runs the outlined parts with the semantics of the whole functions", () => {
		expect(runToStdout(binary)).toBe(expected);
	});

	it("keeps values live across parts rooted under collection stress", () => {
		expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
	});
});
