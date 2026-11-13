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
const outDir = mkdtempSync(join(tmpdir(), "mal-node-http-credit-boundary-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/node-http-credit-boundary.mjs",
		name: "node-http-credit-boundary",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe.each(["compiled", "interpreted"] as const)(
	"HTTP request credit boundary in %s code",
	(backend) => {
		it("completes a request without requiring credit beyond its final body byte", () => {
			for (const env of [{}, STRESS_ENV])
				expect(runToStdout(binaries[backend], { env })).toContain(
					"HTTP CREDIT BOUNDARY PASS",
				);
		});
	},
);
