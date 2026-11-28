import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/function-entry-caches.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-function-entry-caches-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("function entry caches", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "function-entry-caches",
			mainFile: HOST_MAIN,
			evalEnabled: false,
			outDir,
		}));
	});

	it("can access properties and construct literals on first call and after resume", () => {
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
		expect(runToStdout(interpreted)).toBe(expected);
	});
});
