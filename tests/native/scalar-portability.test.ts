import { describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

describe("portable scalar byte transport", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("covers DataView and TypedArray in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/scalar-portability.js",
			name: `scalar-portability-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertResultPass(runToStdout(binary));
	});
});
