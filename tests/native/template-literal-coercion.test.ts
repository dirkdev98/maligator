import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-template-literal-coercion-"));
const expected = ["template-literal-coercion PASS"];

describe("template literal string conversion", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/template-literal-coercion.js",
			name: "template-literal-coercion",
			outDir,
		}));
	}, 600_000);

	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("preserves coercion hints, evaluation order, abrupt completion and tagged values", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("roots substitution values across user coercion under GC stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	}, 120_000);
});
