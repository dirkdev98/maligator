import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const fixture = "tests/local/core-region-property-placement.js";
const expected = "RESULT 42,7,9 getters=2";

describe("Core region property placement", () => {
	it.each([true, false])("preserves property reads (compiled=%s)", (compiled) => {
		const binary = buildNativeBinary({
			fixture,
			name: `core-region-property-placement-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		expect(runToStdout(binary)).toContain(expected);
	});
});
