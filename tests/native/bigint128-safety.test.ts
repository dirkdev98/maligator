import { describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

describe("BigInt promotion at native-width boundaries", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("preserves exact native-width boundary values in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/bigint128-safety.js",
			name: `bigint128-safety-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertResultPass(runToStdout(binary));
	});
});
