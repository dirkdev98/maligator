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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-callee-namespace-"));
const expected = ["callee-namespace PASS"];

describe("module-namespace callee targets", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/callee-namespace.mjs",
			name: "callee-namespace-compiled",
			mainFile: HOST_MAIN,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/callee-namespace.mjs",
			name: "callee-namespace-interpreted",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
		});
	}, 600_000);

	it("preserves live known and opaque export assignments", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("preserves namespace guards and fallback roots under GC stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	});
});
