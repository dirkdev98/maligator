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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-arguments-static-"));
const expected = ["arguments-static PASS"];

describe("static arguments access", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/arguments-static.js",
			name: "arguments-static",
			compiled: true,
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/arguments-static.js",
			name: "arguments-static-ni",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
		});
	});

	for (const [name, binary] of [
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	] as const) {
		it(`${name} preserves direct and object arguments semantics`, () => {
			assertExactLines(runToStdout(binary()), expected);
		});
		it(`${name} preserves arguments lifetimes under GC stress`, () => {
			assertExactLines(
				runToStdout(binary(), { env: STRESS_ENV, timeoutMs: 60000 }),
				expected,
			);
		});
	}
});
