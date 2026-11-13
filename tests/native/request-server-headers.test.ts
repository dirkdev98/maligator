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
const outDir = mkdtempSync(join(tmpdir(), "mal-request-server-headers-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/request-server-headers.mjs",
		name: "request-server-headers",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe.each(["compiled", "interpreted"] as const)(
	"server Request headers in %s code",
	(backend) => {
		it("preserves caller headers across construction, cloning and mutation", () => {
			for (const env of [{}, STRESS_ENV])
				expect(runToStdout(binaries[backend], { env })).toContain(
					"REQUEST SERVER HEADERS PASS",
				);
		});
	},
);
