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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-encoding-aware-text-"));
const expected = [
	"encoding-aware-text strings PASS",
	"encoding-aware-text producers PASS",
	"encoding-aware-text JSON PASS",
];
const hostGc = { MAL_HOST_GC: "1" };

describe("encoding-aware string consumers and JSON traversal", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/encoding-aware-text.js",
			name: "encoding-aware-text",
			outDir,
		}));
	});

	it("preserves UTF-16 semantics and callback order in both backends", () => {
		assertExactLines(runToStdout(compiled, { env: hostGc }), expected);
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("preserves mixed strings and active outputs across collection in both backends", () => {
		const env = { ...hostGc, ...STRESS_ENV };
		assertExactLines(runToStdout(compiled, { env, timeoutMs: 60_000 }), expected);
		assertExactLines(runToStdout(interpreted, { env, timeoutMs: 60_000 }), expected);
	});
});
