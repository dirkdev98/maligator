import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const fixture = "tests/local/immediate_operands.js";
const expected = "true:true:true:true:42:value:true\ntrue:text:7\n";

describe("tagged call operands", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	] as const)("preserves %s call and construction semantics", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture,
			name: `immediate-operands-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		expect(runToStdout(binary)).toBe(expected);
	});
});
