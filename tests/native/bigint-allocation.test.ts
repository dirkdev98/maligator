import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-bigint-allocation-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/bigint-allocation.mjs",
		name: "bigint-allocation",
		mainFile: "tests/fixtures/bigint-allocation/main.c",
		outDir,
		environment: { ...process.env, MAL_PERF_STATS: "1" },
		nodeEnabled: true,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
	});
});
it.each(["compiled", "interpreted"] as const)(
	"propagates BigInt allocation failure before observable effects with %s execution",
	(backend) => {
		expect(runToStdout(pair[backend], { timeoutMs: 60000 })).toBe(
			"bigint-allocation PASS\n",
		);
	},
);
