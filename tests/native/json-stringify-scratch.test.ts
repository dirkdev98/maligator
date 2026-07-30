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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-json-stringify-scratch-"));
const expected = ["json-stringify-scratch PASS"];
const hostGc = { MAL_HOST_GC: "1" };

describe("JSON.stringify traversal scratch buffers", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/json-stringify-scratch.js",
			name: "json-stringify-scratch-compiled",
			compiled: true,
			outDir,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/json-stringify-scratch.js",
			name: "json-stringify-scratch-interpreted",
			compiled: false,
			outDir,
		});
	});

	it("passes compiled and interpreted", () => {
		assertExactLines(runToStdout(compiled, { env: hostGc }), expected);
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("passes compiled and interpreted under GC stress", () => {
		const env = { ...hostGc, ...STRESS_ENV };
		assertExactLines(runToStdout(compiled, { env }), expected);
		assertExactLines(runToStdout(interpreted, { env }), expected);
	});
});
