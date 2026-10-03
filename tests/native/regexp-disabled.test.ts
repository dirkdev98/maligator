import { mkdtempSync, rmSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-regexp-off-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("engine.regexp: false runtime gate", () => {
	let regexpOffBin: string;
	beforeAll(() => {
		regexpOffBin = buildNativeBinary({
			fixture: "tests/local/regexp_disabled.js",
			name: "regexp-disabled",
			mainFile: HOST_MAIN,
			outDir,
			regexpEnabled: false,
		});
	});

	it("links with regress gone; RegExp absent, regex methods throw, string ops work", () => {
		assertResultPass(runToStdout(regexpOffBin));
	});

	it("still holds under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(regexpOffBin, { env: STRESS_ENV }));
	});

	it("drops the regex engine (smaller than the regexp-on binary)", () => {
		const regexpOnBin = buildNativeBinary({
			fixture: "tests/local/regexp_disabled.js",
			name: "regexp-enabled",
			mainFile: HOST_MAIN,
			outDir,
		});
		const offSize = statSync(regexpOffBin).size;
		const onSize = statSync(regexpOnBin).size;
		// regress + its Unicode tables measure well over 100 KB; allow generous slack.
		expect(onSize - offSize).toBeGreaterThan(100_000);
	});
});
