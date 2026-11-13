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

const outDir = mkdtempSync(join(tmpdir(), "mal-node-fetch-upload-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/node-fetch-upload.mjs",
		name: "node-fetch-upload",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		webPlatformEnabled: false,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe.each(["compiled", "interpreted"] as const)(
	"Node fetch uploads in %s code",
	(backend) => {
		it.each([
			["response-headers", "preserves native header lists and separate cookies"],
			["body-init", "encodes body bytes and inferred media types"],
			["stream-upload", "streams chunks before EOF and honors backpressure"],
			["upload-failure", "settles failed uploads and cancels aborted sources"],
			["redirects", "replays buffered bodies and rejects replay of streams"],
			["request-input", "inherits and consumes a Request body"],
		])("%s: %s", (selection) => {
			for (const stress of [{}, STRESS_ENV]) {
				expect(
					runToStdout(binaries[backend], {
						env: { ...stress, MAL_TEST_FETCH_BODY_CASE: selection },
					}),
				).toContain("FETCH UPLOAD PASS");
			}
		});
	},
);
