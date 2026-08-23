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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-shape-case-flow-"));
const expected = ["shape-case-flow PASS"];

describe("SSA shape-case property flow", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/shape-case-flow.js",
			name: "shape-case-flow-compiled",
			compiled: true,
			mainFile: "runtime/shape_case_flow_test_main.c",
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/shape-case-flow.js",
			name: "shape-case-flow-interpreted",
			compiled: false,
			mainFile: "runtime/shape_case_flow_test_main.c",
			outDir,
		});
	}, 600_000);

	it("preserves exact hits and accessor, Proxy, and throw fallbacks", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	});
});
