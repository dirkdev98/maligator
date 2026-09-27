import { beforeAll, describe, expect, it } from "vitest";
import { emitProgramImage } from "../../src/compiler/target/emit-program-image.ts";
import {
	assertExactLines,
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/static-property-projection.js";

describe("native static-property projections", () => {
	let binary: string;
	let source: string;
	let contractBinary: string;

	beforeAll(() => {
		const result = buildNativeBinaryResult({
			fixture,
			name: "static-property-projection",
			compiled: true,
		});
		binary = result.binaryPath;
		source = emitProgramImage(result.programImage, { compiled: true });
		contractBinary = buildNativeBinaryResult({
			fixture,
			name: "static-property-projection-contract",
			compiled: true,
			mainFile: "runtime/static_property_projection_test_main.c",
		}).binaryPath;
	}, 600_000);

	it("preserves Number encodings and untouched outputs on projection misses", () => {
		assertExactLines(runToStdout(contractBinary), ["numeric-projection-contract PASS"]);
	});

	it("shares the warmed shape guard for adjacent own-slot reads", () => {
		expect(source).toContain("mal_vm_property_try_load_static_number_pair(");
		expect(source).toContain("mal_vm_property_try_load_static_number_triple(");
		expect(source).toContain("mal_vm_property_try_load_static_number_quad(");
		expect(source).toContain("f64 __property_projection_");
		expect(source).toMatch(
			/__nf_\d+_ok = true; __nf_\d+_value = __property_projection_\d+_step_/,
		);
		assertExactLines(runToStdout(binary), ["static-property-projection PASS"]);
	});

	it("retains ordered getter and Proxy fallbacks under GC stress", () => {
		assertExactLines(runToStdout(binary, { env: STRESS_ENV }), [
			"static-property-projection PASS",
		]);
	});
});
