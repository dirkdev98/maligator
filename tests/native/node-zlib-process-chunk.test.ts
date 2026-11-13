import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-zlib-process-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/node-zlib-process-chunk.mjs",
		name: "zlib-process",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe.each(["compiled", "interpreted"] as const)(
	"zlib _processChunk in %s code",
	(backend) => {
		it.each([
			"sync",
			"retained",
			"errors",
			"async",
			"async-trailing",
			"destroy",
			"async-error",
		])("preserves %s behavior", (selection) => {
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(binaries[backend], {
						env: { ...stress, MAL_TEST_ZLIB_PROCESS_CASE: selection },
					}),
				).toContain("PROCESS CHUNK PASS");
		});
	},
);
