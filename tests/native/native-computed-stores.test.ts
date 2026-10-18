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

const expected = ["native-computed-stores PASS"];
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-computed-stores-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("native computed-key stores", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-computed-stores.js",
			name: "native-computed-stores",
			outDir,
		}));
	}, 600_000);

	it("stores through varying keys with the property semantics intact", () => {
		assertExactLines(runToStdout(compiled), expected);
	});

	it("does so under collection stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("matches the interpreted semantics", () => {
		assertExactLines(runToStdout(interpreted), expected);
	});
});
