import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-array-destructuring-close-"));

describe("array destructuring assignment IteratorClose", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/array-destructuring-close.js",
			name: "array-destructuring-close",
			outDir,
			skipRuntimeBuild: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/array-destructuring-close.js",
			name: "array-destructuring-close-ni",
			compiled: false,
			outDir,
			skipRuntimeBuild: true,
		});
	});

	it("passes compiled", () => {
		assertPassLine(runToStdout(compiled), "array-destructuring-close");
	});

	it("passes compiled under GC stress", () => {
		assertPassLine(
			runToStdout(compiled, { env: STRESS_ENV }),
			"array-destructuring-close",
		);
	});

	it("passes interpreted", () => {
		assertPassLine(runToStdout(interpreted), "array-destructuring-close");
	});
});
