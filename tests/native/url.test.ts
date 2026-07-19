import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-url-"));

// The URL object holds an ada-url Rust handle freed by a GC finalizer, so the
// STRESS run exercises that lifecycle.
describe("WHATWG URL / URLSearchParams", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/url.js",
			name: "urltest-compiled",
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/url.js",
			name: "urltest-interpreted",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	it("passes compiled", () => {
		assertResultPass(runToStdout(compiled));
	});

	it("passes compiled under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});

	it("passes interpreted", () => {
		assertResultPass(runToStdout(interpreted));
	});

	it("passes interpreted under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});
});
