import { describe, expect, it } from "vitest";
import { emitProgramImage } from "../../src/compiler/target/emit-program-image.ts";
import {
	buildNativeBinary,
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/private-batch.js";

describe("bulk private names and initializer-free instance fields", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	] as const)("preserves %s class semantics", (_name, compiled) => {
		const options = {
			fixture,
			name: `private-batch-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		};
		const result = compiled ? buildNativeBinaryResult(options) : undefined;
		const binary = result?.binaryPath ?? buildNativeBinary(options);
		if (result !== undefined) {
			expect(emitProgramImage(result.programImage, { compiled: true })).toContain(
				"mal_vm_reserve_private_elements(",
			);
		}
		expect(runToStdout(binary)).toBe("private-batch PASS\n");
		expect(runToStdout(binary, { env: STRESS_ENV })).toBe("private-batch PASS\n");
	});
});
