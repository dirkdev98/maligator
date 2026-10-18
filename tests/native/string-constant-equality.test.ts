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

const fixture = "tests/local/string-constant-equality.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-constant-equality-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("strict equality against string constants", () => {
	it("decides every operand kind and string representation like Node", () => {
		const { compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "string-constant-equality",
			outDir,
		});
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
		}
	}, 600000);
});
