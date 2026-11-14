import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-regexp-result-storage-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("RegExp result storage", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves result descriptors, named-index identity and roots under %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture: "tests/local/regexp-result-storage.js",
				name: `regexp-result-storage-${primordials}`,
				outDir,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
				}),
			});
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_HOST_GC: "1", MAL_GC_VERIFY: "1", ...stress },
						}),
					).toBe("PASS\n");
		},
	);
});
