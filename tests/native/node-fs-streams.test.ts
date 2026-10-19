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

it("matches Node for fs vector IO, directory handles, file write streams, and the remaining fs/promises operations", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-fs-streams-test-"));
	const fixture = "tests/local/node-fs-streams.mjs";
	try {
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
		}).trim();
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-fs-streams",
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
