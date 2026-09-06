import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("read-only parameter field entries", () => {
	it("preserves object observation and overridden methods under GC stress", () => {
		const { compiled, interpreted, programImage } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/read-only-field-entries.js",
			name: "read-only-field-entries",
			outDir: mkdtempSync(join(tmpdir(), "mal-read-only-fields-")),
		});
		expect(
			programImage.native.functions.flatMap((fn) => fn.fieldCalls ?? []).length,
		).toBeGreaterThan(0);
		for (const binary of [compiled, interpreted])
			assertExactLines(runToStdout(binary, { env: STRESS_ENV }), [
				"read-only-field-entries PASS",
			]);
	}, 600_000);
});
