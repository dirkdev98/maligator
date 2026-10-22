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

const fixture = "tests/local/slow-path-positions.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-slow-path-positions-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("Positions of operations with a numeric fast path", () => {
	it("report the throwing line when the slow path runs user code", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "slow-path-positions",
			outDir,
			mainFile: HOST_MAIN,
			config: resolveBuildConfig({
				engine: { primordials: "locked", eval: false, realms: false },
			}),
		});
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary, { timeoutMs: 60000 })).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
		}
	}, 600000);
});
