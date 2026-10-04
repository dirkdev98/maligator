import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

describe("runtime decimal text conversion", () => {
	it("parses and formats decimal text exactly like correctly rounded libc conversions", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "number-text",
			mainFile: "tests/fixtures/number-text/main.c",
		});
		expect(runToStdout(binary)).toBe("number-text PASS\n");
	});
});
