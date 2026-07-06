import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import { assertResultPass, buildNativeBinary, HOST_MAIN, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-url-"));

// The URL object holds an ada-url Rust handle freed by a GC finalizer, so the
// STRESS run exercises that lifecycle.
describe("WHATWG URL / URLSearchParams", () => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/url.js",
			name: "urltest",
			mainFile: HOST_MAIN,
			outDir,
			skipRuntimeBuild: true,
		});
	});

	it("passes compiled", () => {
		assertResultPass(runToStdout(bin));
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(bin, { env: STRESS_ENV }));
	});
});
