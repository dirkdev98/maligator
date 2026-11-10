import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-labelled-functions-"));

describe("labelled function declarations", () => {
	let binaries: { compiled: string; interpreted: string };
	beforeAll(() => {
		binaries = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/labelled-function-declarations.js",
			name: "labelled-function-declarations",
			entryGoal: "script",
			entryStrict: false,
			outDir,
		});
	});
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	it.each(["compiled", "interpreted"] as const)(
		"hoists declarations with stable identity and lexical checks when %s",
		(backend) => {
			expect(runToStdout(binaries[backend])).toBe(
				"labelled-function-declarations PASS\n",
			);
			expect(runToStdout(binaries[backend], { env: STRESS_ENV })).toBe(
				"labelled-function-declarations PASS\n",
			);
		},
	);
});
