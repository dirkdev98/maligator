import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertResultPass,
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-regexp-off-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("withholds the RegExp constructor and prototype with locked primordials", () => {
	const fixture = path.join(outDir, "regexp-locked.mjs");
	writeFileSync(
		fixture,
		`console.log(typeof RegExp, typeof globalThis.RegExp, typeof RegExp === "function");
		try { console.log(typeof RegExp.prototype.exec); } catch (error) { console.log(error.name); }
		try { console.log(typeof RegExp.prototype[Symbol.match]); } catch (error) { console.log(error.name); }
		console.log(typeof Symbol.match, "text".match({ [Symbol.match](text) { return text.toUpperCase(); } }));`,
	);
	const binaries = buildBackendPairFromOneProgramImage({
		fixture,
		name: "regexp-disabled-locked",
		outDir,
		config: resolveBuildConfig({ engine: { primordials: "locked", regexp: false } }),
	});
	for (const backend of [binaries.compiled, binaries.interpreted]) {
		expect(runToStdout(backend)).toBe(
			"undefined undefined false\nTypeError\nTypeError\nsymbol TEXT\n",
		);
	}
});

describe("engine.regexp: false runtime gate", () => {
	let regexpOffBin: string;
	beforeAll(() => {
		regexpOffBin = buildNativeBinary({
			fixture: "tests/local/regexp_disabled.js",
			name: "regexp-disabled",
			mainFile: HOST_MAIN,
			outDir,
			evalEnabled: false,
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
			evalEnabled: false,
		});
		const offSize = statSync(regexpOffBin).size;
		const onSize = statSync(regexpOnBin).size;
		// regress + its Unicode tables measure well over 100 KB; allow generous slack.
		expect(onSize - offSize).toBeGreaterThan(100_000);
	});
});
