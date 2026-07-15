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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-limit-p0-"));

describe("engine string length limit", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/string-limit-p0.js",
			name: "string-limit-p0",
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/string-limit-p0.js",
			name: "string-limit-p0-interpreted",
			mainFile: HOST_MAIN,
			compiled: false,
			outDir,
			skipRuntimeBuild: true,
		});
	});

	it("throws catchable RangeErrors in compiled code", () => {
		assertResultPass(runToStdout(compiled));
	});

	it("throws catchable RangeErrors in interpreted code", () => {
		assertResultPass(runToStdout(interpreted));
	});

	it("roots coerced strings under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});
});
