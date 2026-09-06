import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/math-number-native.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-math-number-native-"));
const exactOperations = new Set([
	"abs",
	"floor",
	"ceil",
	"round",
	"trunc",
	"sqrt",
	"sign",
	"fround",
]);
const exactLines = (output: string) =>
	output.split("\n").filter((line) => exactOperations.has(line.split(" ")[0]!));

describe("native numeric Math emission", () => {
	let compiled: string;
	let interpreted: string;
	let expected: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "math-number-native",
			config: resolveBuildConfig({}),
			outDir,
		});
		({ compiled, interpreted } = pair);
		const numericOperations = new Set<string>();
		pair.programImage.runtime.functions.forEach((fn, index) => {
			const operations = fn.instructions.filter(
				(instruction) => instruction.opcode === "MATH_UNARY_NUMBER",
			);
			if (operations.length === 0) return;
			const emitted = emitCompiledFunction(
				fn,
				pair.programImage.native.functions[index]!,
				index,
				"",
				false,
			);
			expect(emitted).not.toBeNull();
			expect(emitted!.source).not.toContain("mal_builtin_math_unary_number_known");
			for (const operation of operations) numericOperations.add(operation.operation);
		});
		expect(numericOperations.size).toBe(27);
	});

	it("matches Node for exact operations at rounding and signed-zero boundaries", () => {
		expect(exactLines(runToStdout(compiled))).toEqual(exactLines(expected));
	});

	it("matches the interpreter for all numeric Math operations and GC stress", () => {
		const reference = runToStdout(interpreted);
		expect(runToStdout(compiled)).toBe(reference);
		expect(runToStdout(compiled, { env: { MAL_HOST_GC: "1", ...STRESS_ENV } })).toBe(
			reference,
		);
	});
});
