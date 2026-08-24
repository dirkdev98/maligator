import { describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("TypedArray and view native kernels", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("preserves public behavior in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/typed-array-native-kernels.js",
			name: `typed-array-native-kernels-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertResultPass(runToStdout(binary));
		assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
	});
});
