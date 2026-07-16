import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const fixture = "tests/local/private-batch.js";

describe("bulk private names and initializer-free instance fields", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	] as const)("preserves %s class semantics", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture,
			name: `private-batch-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		expect(runToStdout(binary)).toBe("private-batch PASS\n");
	});
});
