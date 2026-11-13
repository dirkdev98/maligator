import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-function-source-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/function-source.mjs",
		name: "function-source",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		evalEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
it.each(["compiled", "interpreted"] as const)(
	"reflects exact function, method and class source in %s code",
	(backend) => {
		for (const env of [{}, STRESS_ENV])
			expect(runToStdout(binaries[backend], { env })).toContain("FUNCTION SOURCE PASS");
	},
);
