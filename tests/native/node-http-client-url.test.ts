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

const outDir = mkdtempSync(join(tmpdir(), "mal-http-client-url-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/node-http-client-url.mjs",
		name: "http-client-url",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe.each(["compiled", "interpreted"] as const)(
	"HTTP client URLs in %s code",
	(backend) => {
		it.each(["ipv6", "canonical", "overrides", "invalid"])("handles %s", (selection) => {
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(binaries[backend], {
						env: { ...stress, MAL_TEST_HTTP_URL_CASE: selection },
					}),
				).toContain("HTTP CLIENT URL PASS");
		});
	},
);
