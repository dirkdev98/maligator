import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("numeric text construction", () => {
	for (const [name, compiled] of [
		["compiled", true],
		["interpreted", false],
	] as const) {
		describe(`${name} mode`, () => {
			let binary: string;
			beforeAll(() => {
				binary = buildNativeBinary({
					fixture: "tests/local/numeric-text-construction.js",
					name: `numeric-text-construction-${name}`,
					compiled,
				});
			});
			it(`preserves numeric spelling and observable conversions in ${name} mode`, () => {
				const expected = ["numeric-text-construction PASS"];
				assertExactLines(runToStdout(binary, { env: { MAL_HOST_GC: "1" } }), expected);
				assertExactLines(
					runToStdout(binary, { env: { MAL_HOST_GC: "1", ...STRESS_ENV } }),
					expected,
				);
			});
		});
	}
});
