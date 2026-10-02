import { describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("TypedArray length resolution cache", () => {
	it.each([
		["compiled", true],
		["interpreted", false],
	] as const)(
		"preserves shadowing, live extents and prototype changes in %s mode",
		(_name, compiled) => {
			const binary = buildNativeBinary({
				fixture: "tests/local/typed-array-length-cache.mjs",
				name: `typed-array-length-cache-${compiled ? "compiled" : "interpreted"}`,
				compiled,
				nodeEnabled: true,
				mainFile: HOST_MAIN,
				evalEnabled: false,
				realmsEnabled: false,
				intlEnabled: false,
				temporalEnabled: false,
			});
			expect(runToStdout(binary)).toContain("TYPED ARRAY LENGTH PASS 126");
			expect(runToStdout(binary, { env: STRESS_ENV })).toContain(
				"TYPED ARRAY LENGTH PASS 126",
			);
		},
	);
});
