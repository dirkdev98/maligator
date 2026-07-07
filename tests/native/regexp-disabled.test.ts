import { mkdtempSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

// The runtime half of `engine.regexp: false` (the compile-time regex-literal check
// is covered by tests/build-config.test.ts). Builds the fixture into the regexp-off
// archive: `-DMAL_REGEXP=0` compiles builtin_regexp.c / regexp_object.c away and the
// Rust crate is built without the `regexp` feature, so the regress engine + its
// Unicode tables are dropped. That this binary LINKS at all — no `mal_regexp_*`
// symbols in the archive, gc.c's finalizer guarded — is the core assertion; the
// fixture then confirms RegExp is absent, regex String methods throw, and pure
// string ops still work. Builds its own archive under a `-<hash>` suffixed dir.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-regexp-off-"));

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
			skipRuntimeBuild: true, // regexp-on archive was prebuilt by globalSetup
		});
		const offSize = statSync(regexpOffBin).size;
		const onSize = statSync(regexpOnBin).size;
		// regress + its Unicode tables measure well over 100 KB; allow generous slack.
		expect(onSize - offSize).toBeGreaterThan(100_000);
	});
});
