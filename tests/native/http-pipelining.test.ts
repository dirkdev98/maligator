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

const fixture = "tests/local/http-pipelining.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-http-pipelining-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
let expected: string;
beforeAll(() => {
	expected = execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		timeout: 30000,
	});
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "http-pipelining",
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
	"answers pipelined requests in order with %s execution",
	(backend) => {
		expect(runToStdout(pair[backend], { timeoutMs: 60000 })).toBe(expected);
	},
);
