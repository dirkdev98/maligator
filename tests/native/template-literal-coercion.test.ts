import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
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
			mainFile: HOST_MAIN,
			outDir,
		}));
	}, 600_000);

	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("preserves coercion, length errors, representations and suspension", () => {
		assertExactLines(runToStdout(compiled, { env: { MAL_HOST_GC: "1" } }), expected);
		assertExactLines(runToStdout(interpreted, { env: { MAL_HOST_GC: "1" } }), expected);
	});

	it("roots substitution values across user coercion under GC stress", () => {
		const env = { ...STRESS_ENV, MAL_HOST_GC: "1" };
		assertExactLines(runToStdout(compiled, { env }), expected);
		assertExactLines(runToStdout(interpreted, { env }), expected);
	}, 120_000);
});
