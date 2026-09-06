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

describe("typed and fixed-arity internal entries", () => {
	it("preserves generic calls, argument observations, and roots under GC stress", () => {
		const { compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/typed-internal-entries.js",
			name: "typed-internal-entries",
			outDir: mkdtempSync(join(tmpdir(), "mal-typed-internal-entries-")),
		});
		for (const binary of [compiled, interpreted])
			assertExactLines(runToStdout(binary, { env: STRESS_ENV }), [
				"typed-internal-entries PASS",
			]);
	}, 600_000);
});
