import { describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

describe("ToInt32 and left-shift wrapping", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("wraps modulo 2^32 in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/int-bitwise-wrap.js",
			name: `int-bitwise-wrap-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertResultPass(runToStdout(binary));
	});
});
