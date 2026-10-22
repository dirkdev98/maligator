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

const fixture = "tests/local/private-field-elements.mjs";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-private-field-elements-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("Arrays that only private fields hold", () => {
	it("read elements of every kind their holders can store, and give up on arrays that escape", () => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "private-field-elements",
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
