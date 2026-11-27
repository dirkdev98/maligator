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

const fixture = "tests/local/strict-mode-inline-boundary.cjs";
const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });

it.each(["mutable", "locked"] as const)(
	"matches Node for calls across a strictness boundary with %s primordials",
	(primordials) => {
		const outDir = mkdtempSync(join(tmpdir(), "mal-strict-mode-inline-boundary-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `strict-mode-inline-boundary-${primordials}`,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
				}),
				outDir,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 })).toBe(
					expected,
				);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	},
	600_000,
);
