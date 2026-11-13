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

const outDir = mkdtempSync(join(tmpdir(), "mal-node-http-bodyless-length-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/node-http-bodyless-length.mjs",
		name: "node-http-bodyless-length",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe.each(["compiled", "interpreted"] as const)(
	"Bodyless HTTP response lengths in %s code",
	(backend) => {
		it("preserves explicit representation lengths without sending a body", () => {
			for (const env of [{}, STRESS_ENV])
				expect(runToStdout(binaries[backend], { env })).toContain(
					"HTTP BODYLESS LENGTH PASS",
				);
		});
	},
);
