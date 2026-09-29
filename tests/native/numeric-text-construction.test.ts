import { describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("numeric text construction", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	])(
		"preserves numeric spelling and observable conversions in %s mode",
		(_name, compiled) => {
			const binary = buildNativeBinary({
				fixture: "tests/local/numeric-text-construction.js",
				name: `numeric-text-construction-${compiled ? "compiled" : "interpreted"}`,
				compiled,
			});
			const expected = ["numeric-text-construction PASS"];
			assertExactLines(runToStdout(binary, { env: { MAL_HOST_GC: "1" } }), expected);
			assertExactLines(
				runToStdout(binary, { env: { MAL_HOST_GC: "1", ...STRESS_ENV } }),
				expected,
			);
		},
	);
});
