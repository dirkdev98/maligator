import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

const fixture = "tests/local/node-fs-bigint-stats.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-node-fs-bigint-stats-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
let expected: string;
beforeAll(() => {
	expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "node-fs-bigint-stats",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
	});
});
it.each(["compiled", "interpreted"] as const)(
	"reports BigIntStats for { bigint: true } with %s execution",
	(backend) => {
		expect(runToStdout(pair[backend], { timeoutMs: 30000 })).toBe(expected);
	},
);
