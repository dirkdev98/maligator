import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each([
	{ label: "default", config: undefined },
	{
		label: "eval and realms disabled",
		config: resolveBuildConfig({
			engine: { eval: false, realms: false },
			surface: { node: true, webPlatform: false },
		}),
	},
])(
	"creates temporary directories with Node encodings, option effects, callback timing, and async branding ($label)",
	({ config }) => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-mkdtemp-"));
		const fixture = "tests/local/node-fs-mkdtemp.mjs";
		try {
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
				env: { ...process.env, MAL_MKDTEMP_ROOT: directory },
			}).trim();
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				config,
				name: "node-fs-mkdtemp",
				outDir: directory,
				mainFile: HOST_MAIN,
				nodeEnabled: true,
				webPlatformEnabled: false,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				for (const env of [{}, STRESS_ENV]) {
					expect(
						runToStdout(binary, { env: { ...env, MAL_MKDTEMP_ROOT: directory } }).trim(),
					).toBe(expected);
				}
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
