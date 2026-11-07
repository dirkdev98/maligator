import { describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN, runToStdout } from "../../src/test-harness.ts";

describe("CommonJS star re-exports", () => {
	it("expose the re-exported names on static and dynamic import namespaces", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/cjs-star-reexports.mjs",
			name: "cjs-star-reexports",
			mainFile: HOST_MAIN,
			nodeEnabled: true,
		});
		expect(runToStdout(binary)).toBe("star star true\n");
	});
});
