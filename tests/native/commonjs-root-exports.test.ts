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

// tests/core-commonjs-call-targets.test.ts pins which of these calls resolve exactly.
it("calls functions exported through module.exports like Node, cycles and replacements included", () => {
	const fixture = "tests/local/commonjs-root-exports/main.cjs";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const outDir = mkdtempSync(join(tmpdir(), "mal-commonjs-root-exports-"));
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "commonjs-root-exports",
			config: resolveBuildConfig({}),
			outDir,
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 })).toBe(expected);
		}
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 600_000);
