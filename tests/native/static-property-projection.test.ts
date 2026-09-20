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

	beforeAll(() => {
		const result = buildNativeBinaryResult({
			fixture,
			name: "static-property-projection",
			compiled: true,
		});
		binary = result.binaryPath;
		source = emitProgramImage(result.programImage, { compiled: true });
	}, 600_000);

	it("shares the warmed shape guard for adjacent own-slot reads", () => {
		expect(source).toContain("mal_vm_property_try_load_static_pair(");
		assertExactLines(runToStdout(binary), ["static-property-projection PASS"]);
	});

	it("retains ordered getter and Proxy fallbacks under GC stress", () => {
		assertExactLines(runToStdout(binary, { env: STRESS_ENV }), [
			"static-property-projection PASS",
		]);
	});
});
