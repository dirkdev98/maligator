import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-polymorphic-static-loads-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("static loads over alternating shapes", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/polymorphic-static-loads.js",
			name: "polymorphic-static-loads",
			outDir,
		}));
	}, 600_000);

	for (const mode of ["compiled", "interpreted"] as const) {
		it(`reads each shape's own field in ${mode} mode`, () => {
			const binary = mode === "compiled" ? compiled : interpreted;
			assertResultPass(runToStdout(binary));
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
		});
	}
});
