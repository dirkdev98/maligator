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

const expected = ["native-in-operator PASS"];
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-in-operator-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("native in operator over shaped objects", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-in-operator.js",
			name: "native-in-operator",
			outDir,
		}));
	}, 600_000);

	it("answers own, inherited and proxied keys", () => {
		assertExactLines(runToStdout(compiled), expected);
	});

	it("answers them under collection stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("matches the interpreted semantics", () => {
		assertExactLines(runToStdout(interpreted), expected);
	});
});
