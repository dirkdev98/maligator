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

const outDir = mkdtempSync(join(tmpdir(), "mal-node-net-blocklist-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/node-net-blocklist.mjs",
		name: "node-net-blocklist",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe.each(["compiled", "interpreted"] as const)("BlockList in %s code", (backend) => {
	it.each(["subnets", "ranges", "rules", "validation"])("matches %s", (selection) => {
		for (const stress of [{}, STRESS_ENV])
			expect(
				runToStdout(binaries[backend], {
					env: { ...stress, MAL_TEST_BLOCKLIST_CASE: selection },
				}),
			).toContain("BLOCKLIST PASS");
	});
});
