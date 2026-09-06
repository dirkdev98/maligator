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

describe("bounded arithmetic and TypedArray indices", () => {
	it("preserves signed zero, invalid indices, aliases, and surrounding GC", () => {
		const { compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/bounded-numeric-accesses.js",
			name: "bounded-numeric-accesses",
			outDir: mkdtempSync(join(tmpdir(), "mal-bounded-numeric-accesses-")),
		});
		for (const binary of [compiled, interpreted])
			assertExactLines(runToStdout(binary, { env: STRESS_ENV }), [
				"bounded-numeric-accesses PASS",
			]);
	}, 600_000);
});
