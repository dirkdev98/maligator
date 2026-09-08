import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each([
	["locked", false],
	["mutable", false],
	["locked", true],
] as const)(
	"preserves discovery semantics with %s primordials and profiling %s",
	(primordials, profileEnabled) => {
		const fixture = "tests/local/static-value-discovery.mjs";
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const outDir = mkdtempSync(join(tmpdir(), "mal-static-discovery-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "discovery",
				profileEnabled,
				config: resolveBuildConfig({ engine: { primordials } }),
				outDir,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	},
	600000,
);
