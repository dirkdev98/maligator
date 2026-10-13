import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("checks filesystem access off-thread with Node callbacks, promises, errors, and async context", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-fs-access-"));
	const fixture = "tests/local/node-fs-access.mjs";
	try {
		const present = path.join(directory, "present");
		const readonly = path.join(directory, "readonly");
		writeFileSync(present, "data");
		writeFileSync(readonly, "data");
		chmodSync(readonly, 0o400);
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, MAL_FS_ACCESS_ROOT: directory },
		}).trim();
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-fs-access",
			outDir: directory,
			mainFile: HOST_MAIN,
			nodeEnabled: true,
			webPlatformEnabled: false,
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			for (const env of [{}, STRESS_ENV]) {
				expect(
					runToStdout(binary, { env: { ...env, MAL_FS_ACCESS_ROOT: directory } }).trim(),
				).toBe(expected);
			}
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
