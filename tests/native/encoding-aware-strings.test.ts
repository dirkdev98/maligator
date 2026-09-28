import { describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

describe("physical string encoding and segment contracts", () => {
	it("preserves compact storage through hashing, slices, collection and a JSON pipeline", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "encoding-aware-strings",
			mainFile: "tests/fixtures/encoding-aware-strings/main.c",
		});
		expect(runToStdout(binary, { env: { MAL_GC_VERIFY: "1" } })).toBe(
			"encoding-aware-strings PASS\n",
		);
	});
});
