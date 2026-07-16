import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const fixture = "tests/local/global-var-batch.js";

describe("batched global var initialization", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	] as const)("preserves %s declaration semantics", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture,
			name: `global-var-batch-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		expect(runToStdout(binary)).toBe("global-var-batch PASS\n");
	});
});
