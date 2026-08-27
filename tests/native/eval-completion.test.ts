import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-eval-completion-"));

describe("eval statement completion values", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/eval-completion.js",
			name: "eval-completion",
			outDir,
		}));
	});

	it("passes compiled", () => {
		assertPassLine(runToStdout(compiled), "eval-completion");
	});

	it("passes interpreted", () => {
		assertPassLine(runToStdout(interpreted), "eval-completion");
	});
});
