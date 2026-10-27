import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("native constructor return kinds", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves completions and roots with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(join(tmpdir(), "mal-return-completion-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/return-completion-kinds.mjs",
					name: `return-completion-${primordials}`,
					mainFile: HOST_MAIN,
					outDir,
					nativeStackRoots: "precise",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: true },
					}),
				});
				for (const binary of [pair.compiled, pair.interpreted])
					for (const env of [{}, { ...STRESS_ENV, MAL_HOST_GC: "1" }])
						assertExactLines(runToStdout(binary, { env }), [
							"return-completion-kinds PASS",
						]);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
	);
});
