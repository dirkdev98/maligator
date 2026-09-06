import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("activation captures and primitive input paths", () => {
	it("preserves shared captures and fallible key/argument timing under GC stress", () => {
		const { compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/activation-input-facts.js",
			name: "activation-input-facts",
			outDir: mkdtempSync(join(tmpdir(), "mal-activation-input-facts-")),
		});
		for (const binary of [compiled, interpreted])
			assertExactLines(runToStdout(binary, { env: STRESS_ENV }), [
				"activation-input-facts PASS",
			]);
	}, 600_000);
});
