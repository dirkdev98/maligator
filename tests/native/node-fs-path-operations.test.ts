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

it("renames and unlinks paths off-thread with Node callbacks, errors, and captured implementations", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-fs-path-operations-"));
	const fixture = "tests/local/node-fs-path-operations.mjs";
	try {
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, MAL_FS_PATH_ROOT: directory },
		}).trim();
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-fs-path-operations",
			outDir: directory,
			mainFile: HOST_MAIN,
			nodeEnabled: true,
			webPlatformEnabled: false,
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			for (const env of [{}, STRESS_ENV]) {
				expect(
					runToStdout(binary, { env: { ...env, MAL_FS_PATH_ROOT: directory } }).trim(),
				).toBe(expected);
			}
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
