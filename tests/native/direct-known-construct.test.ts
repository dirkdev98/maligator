import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-direct-known-construct-"));
const expected = ["direct-known-construct PASS"];

describe("structural direct script-function construction", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/direct-known-construct.js",
			name: "direct-known-construct-compiled",
			compiled: true,
			mainFile: "runtime/direct_construct_test_main.c",
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/direct-known-construct.js",
			name: "direct-known-construct-interpreted",
			compiled: false,
			mainFile: "runtime/direct_construct_test_main.c",
			outDir,
		});
	}, 600_000);

	it("preserves constructor semantics and roots under GC stress", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("enters interpreted targets directly and generically constructs on guard miss", () => {
		assertExactLines(runToStdout(interpreted), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	});
});
