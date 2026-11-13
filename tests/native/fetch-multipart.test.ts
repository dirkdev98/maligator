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
const outDir = mkdtempSync(join(tmpdir(), "mal-fetch-multipart-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/fetch-multipart.mjs",
		name: "fetch-multipart",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe.each(["compiled", "interpreted"] as const)(
	"multipart body parsing in %s code",
	(backend) => {
		it.each(["fields", "files", "stream", "empty", "invalid", "boundary-data"])(
			"handles %s",
			(selection) => {
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binaries[backend], {
							env: { ...stress, MAL_TEST_MULTIPART_CASE: selection },
						}),
					).toContain("MULTIPART PASS");
			},
		);
	},
);
