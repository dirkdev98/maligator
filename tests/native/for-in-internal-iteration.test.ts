import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/for-in-internal-iteration.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-for-in-internal-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("for-in key iteration", () => {
	it("ignores patched array iterator methods and shares per-shape keys across loops", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "for-in-internal-iteration",
			outDir,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({
				engine: { primordials: "mutable", eval: false, realms: false },
				surface: { node: true },
			}),
		});
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		expect(expected).toContain("observed 0");
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary, { timeoutMs: 60000 })).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
		}
	}, 600000);
});
