import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneDefinition,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-iterator-helper-fast-path-"));
const expected = ["iterator-helper-fast-path PASS"];

describe("iterator and iterator-helper native fast paths", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneDefinition({
			fixture: "tests/local/iterator-helper-fast-path.js",
			name: "iterator-helper-fast-path",
			outDir,
		}));
	}, 600_000);

	it("preserves public, chained, overridden, and closing semantics", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("keeps nested helper state rooted under GC stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
		assertExactLines(runToStdout(interpreted, { env: STRESS_ENV }), expected);
	});
});
