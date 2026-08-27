import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-duplicate-functions-"));

describe("duplicate function declarations", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/duplicate-function-declarations.js",
			name: "duplicate-function-declarations",
			entryGoal: "script",
			outDir,
		}));
	});

	it("uses the final body when compiled", () => {
		assertPassLine(runToStdout(compiled), "duplicate-function-declarations");
	});

	it("uses the final body when interpreted", () => {
		assertPassLine(runToStdout(interpreted), "duplicate-function-declarations");
	});
});
