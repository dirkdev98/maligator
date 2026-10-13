import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("converts URL fields and enumerable extensions with Node's getter and coercion order", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-url-http-options-"));
	const fixture = "tests/local/node-url-http-options.mjs";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" }).trim();
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-url-http-options",
			outDir: directory,
			mainFile: HOST_MAIN,
			nodeEnabled: true,
			webPlatformEnabled: false,
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			for (const env of [{}, STRESS_ENV]) {
				expect(runToStdout(binary, { env }).trim()).toBe(expected);
			}
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
