import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

describe("native Unicode ASCII paths", () => {
	it("preserves locale context, expansion, composition and lone surrogates in mixed text", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "unicode-ascii-transforms",
			mainFile: "tests/fixtures/unicode-ascii-transforms/main.c",
		});
		expect(runToStdout(binary)).toBe("unicode-ascii-transforms PASS\n");
	});
});
