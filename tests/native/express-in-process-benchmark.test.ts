import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
} from "../../src/test-harness.ts";

const fixture = "bench/http/express-in-process.cjs";
const directory = mkdtempSync(path.join(tmpdir(), "mal-express-in-process-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function observable(stdout: string): unknown {
	const { mode, control, completed, checksum, oracles } = JSON.parse(stdout) as Record<
		string,
		unknown
	>;
	return { mode, control, completed, checksum, oracles };
}

describe("Express without HTTP transport", () => {
	let binaries: Array<string>;
	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "express-in-process",
			outDir: directory,
			nodeEnabled: true,
			webPlatformEnabled: true,
			evalEnabled: false,
			realmsEnabled: false,
			intlEnabled: false,
			temporalEnabled: false,
			production: true,
		});
		binaries = [pair.compiled, pair.interpreted];
	}, 600_000);
	for (const mode of ["parsed", "raw"]) {
		it(`matches Node responses, middleware, async errors and headers with ${mode} bodies`, () => {
			const env = {
				EXPRESS_REQUESTS: "100",
				EXPRESS_DURATION_MS: "0",
				EXPRESS_IN_PROCESS_MODE: mode,
				EXPRESS_ADAPTER_CONTROL: "0",
			};
			const expected = observable(
				execFileSync(process.execPath, [fixture], {
					env: { ...process.env, ...env },
					encoding: "utf8",
				}),
			);
			for (const binary of binaries)
				expect(observable(runToStdout(binary, { env, timeoutMs: 60_000 }))).toEqual(
					expected,
				);
		}, 180_000);
	}
});
