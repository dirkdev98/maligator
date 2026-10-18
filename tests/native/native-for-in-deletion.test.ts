import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const expected = ["native-for-in-deletion PASS"];
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-for-in-deletion-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("native for-in over keys deleted during enumeration", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-for-in-deletion.js",
			name: "native-for-in-deletion",
			outDir,
		}));
	}, 600_000);

	it("skips keys deleted before their turn", () => {
		assertExactLines(runToStdout(compiled), expected);
	});

	it("skips them under collection stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("matches the interpreted semantics", () => {
		assertExactLines(runToStdout(interpreted), expected);
	});
});
