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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-spread-iterable-"));

describe("array spread iterable operation", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/array-spread-iterable.js",
			name: "array-spread-iterable",
			outDir,
		}));
	});

	it("preserves compiled semantics", () => {
		assertPassLine(runToStdout(compiled), "array-spread-iterable");
	});

	it("preserves compiled semantics under GC stress", () => {
		assertPassLine(runToStdout(compiled, { env: STRESS_ENV }), "array-spread-iterable");
	});

	it("preserves interpreted semantics", () => {
		assertPassLine(runToStdout(interpreted), "array-spread-iterable");
	});
});
