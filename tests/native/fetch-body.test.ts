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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-fetch-body-"));

describe("Request and Response Body streams", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/fetch_body.js",
			name: "fetch-body-compiled",
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/fetch_body.js",
			name: "fetch-body-interpreted",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	it("passes compiled", () => {
		assertResultPass(runToStdout(compiled));
	});

	it("passes interpreted", () => {
		assertResultPass(runToStdout(interpreted));
	});

	it("passes compiled under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});

	it("passes interpreted under GC stress", () => {
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});
});
