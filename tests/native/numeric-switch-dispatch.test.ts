import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("numeric native switch dispatch", () => {
	it("preserves strict selection, duplicate labels, fallthrough and loop edges under GC stress", () => {
		const { compiled, interpreted, programImage } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/numeric-switch-dispatch.js",
			name: "numeric-switch-dispatch",
			outDir: mkdtempSync(join(tmpdir(), "mal-numeric-switch-")),
		});
		expect(
			programImage.native.functions.flatMap((fn) => fn.numericSwitches ?? []).length,
		).toBeGreaterThan(0);
		for (const binary of [compiled, interpreted])
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
				"numeric-switch-dispatch PASS\n",
			);
	}, 600_000);
});
