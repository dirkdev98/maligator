import { describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/finite-string-region.js";

describe("finite string regions", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("preserves string and key semantics in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture,
			name: `finite-string-region-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertResultPass(runToStdout(binary));
	});

	it("keeps program-image strings valid under verified GC stress", () => {
		const binary = buildNativeBinary({
			fixture,
			name: "finite-string-region-stress",
			compiled: true,
		});
		const output = runToStdout(binary, { env: STRESS_ENV });
		expect(output).toContain("RESULT 4/4");
	});
});
