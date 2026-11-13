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
const outDir = mkdtempSync(join(tmpdir(), "mal-fetch-iterable-body-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/fetch-iterable-body.mjs",
		name: "fetch-iterable-body",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe.each(["compiled", "interpreted"] as const)(
	"iterable Fetch bodies in %s code",
	(backend) => {
		it.each(["bytes", "cancel", "errors"])("handles %s", (selection) => {
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(binaries[backend], {
						env: { ...stress, MAL_TEST_ITERABLE_BODY_CASE: selection },
					}),
				).toContain("FETCH ITERABLE BODY PASS");
		});
	},
);
