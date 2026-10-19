import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/arguments-lazy-body.cjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-arguments-lazy-body-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("lazy arguments with body reads", () => {
	it("reads the frame until a body use observes the object, then the object", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "arguments-lazy-body",
			entryGoal: "script",
			entryStrict: false,
			outDir,
		});
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
		}
	}, 600000);
});
