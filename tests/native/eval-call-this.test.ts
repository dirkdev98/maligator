import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-eval-call-this-"));

describe("calls from direct eval code", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/eval-call-this.js",
			name: "eval-call-this",
			outDir,
		}));
	});

	it("passes compiled", () => {
		assertPassLine(runToStdout(compiled), "eval-call-this");
	});

	it("passes interpreted", () => {
		assertPassLine(runToStdout(interpreted), "eval-call-this");
	});
});
