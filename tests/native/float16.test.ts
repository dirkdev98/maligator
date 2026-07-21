import { describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
} from "../../src/test-harness.ts";

describe("shared IEEE-754 binary16 conversion", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("covers DataView and Math.f16round in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/float16.js",
			name: `float16-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertResultPass(runToStdout(binary));
	});
});
