import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-interpreter-branches-"));
const expected = ["interpreter-branches PASS"];

describe("interpreter branch dispatch", () => {
	let interpreted: string;

	beforeAll(() => {
		interpreted = buildNativeBinary({
			fixture: "tests/local/interpreter-branches.js",
			name: "interpreter-branches",
			compiled: false,
			outDir,
		});
	});

	it("preserves forward branches, backedges, and exception IPs", () => {
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("keeps branch-loop values rooted at GC safepoints", () => {
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	});
});
