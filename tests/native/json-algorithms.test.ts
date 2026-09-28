import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-json-algorithms-"));
const expected = ["json-algorithms PASS"];
const hostGc = { MAL_HOST_GC: "1" };

describe("JSON bounded resources and token traversal", () => {
	let compiled: string;
	let interpreted: string;
	let fiber: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/json-algorithms.js",
			name: "json-algorithms",
			outDir,
		}));
		fiber = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "json-fiber",
			mainFile: "tests/fixtures/json-algorithms/fiber-main.c",
			outDir,
		});
	});

	it("preserves callbacks, sources, and bounded failure in both backends", () => {
		assertExactLines(runToStdout(compiled, { env: hostGc }), expected);
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("bounds recursive work on the scheduler's smaller fiber stack", () => {
		assertExactLines(runToStdout(fiber), ["json-fiber PASS"]);
		assertExactLines(runToStdout(fiber, { env: STRESS_ENV }), ["json-fiber PASS"]);
	});

	it("keeps active values and source records rooted under GC stress", () => {
		const env = { ...hostGc, ...STRESS_ENV };
		assertExactLines(runToStdout(compiled, { env }), expected);
		assertExactLines(runToStdout(interpreted, { env }), expected);
	});
});
