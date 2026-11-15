import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/string-split-escape.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-split-escape-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("split and trim values escaping a cursor loop", () => {
	let binaries: { compiled: string; interpreted: string };
	beforeAll(() => {
		binaries = buildBackendPairFromOneProgramImage({
			fixture,
			name: "split-escape",
			outDir,
			config: resolveBuildConfig({ engine: { eval: true } }),
		});
	});
	it("preserves returned, thrown and loop-carried values like Node", () => {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [binaries.compiled, binaries.interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		}
	});
});
