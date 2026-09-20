import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const fixture = "tests/local/public-field-static-key.js";

describe("static public class-field keys", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	] as const)("preserves %s own-definition semantics", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture,
			name: `public-field-static-key-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		expect(runToStdout(binary)).toBe("public-field-static-key PASS\n");
		expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
			"public-field-static-key PASS\n",
		);
	});
});
