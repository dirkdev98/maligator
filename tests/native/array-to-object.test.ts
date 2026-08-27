import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-to-object-"));

describe("generic Array.prototype ToObject", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/array-to-object.js",
			name: "array-to-object",
			outDir,
		}));
	});

	it("passes compiled", () => {
		assertPassLine(runToStdout(compiled), "array-to-object");
	});

	it("passes compiled under GC stress", () => {
		assertPassLine(runToStdout(compiled, { env: STRESS_ENV }), "array-to-object");
	});

	it("passes interpreted", () => {
		assertPassLine(runToStdout(interpreted), "array-to-object");
	});
});
