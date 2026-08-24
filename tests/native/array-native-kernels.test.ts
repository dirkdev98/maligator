import { describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("Array native kernels", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])(
		"preserves constructor, static, and receiver behavior in %s mode",
		(_name, compiled) => {
			const binary = buildNativeBinary({
				fixture: "tests/local/array-native-kernels.js",
				name: `array-native-kernels-${compiled ? "compiled" : "interpreted"}`,
				compiled,
				mainFile: HOST_MAIN,
			});
			assertResultPass(runToStdout(binary));
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
		},
	);
});
