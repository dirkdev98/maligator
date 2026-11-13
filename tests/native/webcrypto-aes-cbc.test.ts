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
const outDir = mkdtempSync(join(tmpdir(), "mal-webcrypto-aes-cbc-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/webcrypto-aes-cbc.mjs",
		name: "webcrypto-aes-cbc",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe.each(["compiled", "interpreted"] as const)(
	"AES-CBC WebCrypto in %s code",
	(backend) => {
		it.each(["vectors", "inputs", "errors"])("handles %s", (selection) => {
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(binaries[backend], {
						env: { ...stress, MAL_TEST_AES_CBC_CASE: selection },
					}),
				).toContain("WEBCRYPTO AES-CBC PASS");
		});
	},
);
