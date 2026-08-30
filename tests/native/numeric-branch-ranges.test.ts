import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-numeric-branch-ranges-"));

describe("numeric branch range semantics", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/numeric-branch-ranges.js",
			name: "numeric-branch-ranges",
			outDir,
		}));
	}, 600_000);

	it("preserves edge polarity and conservative numeric cases in both backends", () => {
		for (const binary of [compiled, interpreted]) {
			assertExactLines(runToStdout(binary), ["numeric-branch-ranges PASS"]);
		}
	});
});
