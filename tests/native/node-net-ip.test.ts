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

it("matches Node IP predicates, coercion order, zone identifiers, and construction", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "mal-net-ip-"));
	const fixture = "tests/local/node-net-ip.mjs";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" }).trim();
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "node-net-ip",
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
