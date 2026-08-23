import { describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("numeric abstract operations", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])("shares pure-number tails in %s mode", (_name, compiled) => {
		const binary = buildNativeBinary({
			fixture: "tests/local/numeric-abstract-ops.js",
			name: `numeric-abstract-ops-${compiled ? "compiled" : "interpreted"}`,
			compiled,
		});
		assertResultPass(runToStdout(binary));
		if (compiled) {
			assertResultPass(
				runToStdout(binary, {
					env: { ...STRESS_ENV, MAL_HOST_GC: "1" },
				}),
			);
		}
	});
});
