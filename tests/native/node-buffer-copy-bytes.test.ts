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

it("copies typed-array bytes with Node's bounds, validation, and construction behavior", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-buffer-copy-bytes-"));
	const fixture = "tests/local/node-buffer-copy-bytes.mjs";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" }).trim();
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-buffer-copy-bytes",
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
