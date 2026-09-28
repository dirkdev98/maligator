import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-json-algorithms-"));
const expected = ["json-algorithms PASS"];
const hostGc = { MAL_HOST_GC: "1" };

describe("JSON bounded resources and token traversal", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/json-algorithms.js",
			name: "json-algorithms",
			outDir,
		}));
	});

	it("preserves callbacks, sources, and bounded failure in both backends", () => {
		assertExactLines(runToStdout(compiled, { env: hostGc }), expected);
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("keeps active values and source records rooted under GC stress", () => {
		const env = { ...hostGc, ...STRESS_ENV };
		assertExactLines(runToStdout(compiled, { env }), expected);
		assertExactLines(runToStdout(interpreted, { env }), expected);
	});
});
