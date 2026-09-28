import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

describe("compact string runtime and host boundaries", () => {
	it("keeps predicates and headers compact and reacquires iterator leaves across GC", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/compact-string-boundaries.mjs",
			name: "compact-string-boundaries",
			mainFile: "tests/fixtures/compact-string-boundaries/main.c",
			nodeEnabled: true,
		});
		expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
			"compact-string-boundaries PASS\n",
		);
	});
});
