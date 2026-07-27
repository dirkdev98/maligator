import { describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("TypedArray.prototype.set same-buffer overlap", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("snapshots cross-kind sources in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/typed-array-set-overlap.js",
			name: `typed-array-set-overlap-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertResultPass(runToStdout(binary));
		assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
	});
});
