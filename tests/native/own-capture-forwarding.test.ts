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

const fixture = "tests/local/own-capture-forwarding.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-own-capture-forwarding-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("Owner reads of its own captured bindings", () => {
	it("observe every store, closure write and binding alias", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "own-capture-forwarding",
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
