import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import type { BackendPairResult } from "../../src/test-harness.ts";

const fixture = "tests/local/static-binding-constants.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-binding-constants-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("module constants folded into their readers", () => {
	let expected: string;
	let pair: BackendPairResult;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "static-binding-constants",
			mainFile: HOST_MAIN,
			outDir,
			config: resolveBuildConfig({}),
		});
	}, 600_000);

	it("keeps values and the TDZ error of an early read in compiled code", () => {
		expect(runToStdout(pair.compiled)).toBe(expected);
		expect(runToStdout(pair.compiled, { env: STRESS_ENV })).toBe(expected);
	});

	it("keeps values and the TDZ error of an early read in interpreted code", () => {
		expect(runToStdout(pair.interpreted)).toBe(expected);
	});
});
