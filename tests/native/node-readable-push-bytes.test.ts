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
const outDir = mkdtempSync(join(tmpdir(), "mal-node-readable-push-bytes-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/node-readable-push-bytes.mjs",
		name: "node-readable-push-bytes",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe.each(["compiled", "interpreted"] as const)(
	"Readable byte chunks in %s code",
	(backend) => {
		it("encodes pushed strings into bytes and preserves object-mode strings", () => {
			for (const env of [{}, STRESS_ENV])
				expect(runToStdout(binaries[backend], { env })).toContain(
					"READABLE PUSH BYTES PASS",
				);
		});
	},
);
