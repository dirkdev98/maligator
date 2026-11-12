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

const outDir = mkdtempSync(join(tmpdir(), "mal-http-outgoing-headers-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/node-http-outgoing-headers.cjs",
		name: "http-outgoing-headers",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it.each(["compiled", "interpreted"] as const)(
	"stores outgoing headers through transport completion and honors edits in %s code",
	(backend) => {
		expect(runToStdout(binaries[backend])).toContain("OUTGOING HEADERS PASS");
	},
);

it.each(["compiled", "interpreted"] as const)(
	"retains outgoing header values and guards reentrant serialization under GC stress in %s code",
	(backend) => {
		expect(runToStdout(binaries[backend], { env: STRESS_ENV })).toContain(
			"OUTGOING HEADERS PASS",
		);
	},
);
