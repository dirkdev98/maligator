import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-constructor-derived-call-"));
const expected = ["constructor-derived-call PASS"];

describe("constructor-derived callee targets", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/constructor-derived-call.mjs",
			name: "constructor-derived-call-compiled",
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/constructor-derived-call.mjs",
			name: "constructor-derived-call-interpreted",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
		});
	}, 600_000);

	it("preserves exact prototype hits and every generic fallback", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("keeps constructor, prototype, and replacement values rooted", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	});
});
