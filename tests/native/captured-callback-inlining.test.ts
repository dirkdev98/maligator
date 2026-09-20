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

it("inlines nonescaping captured callbacks without changing guarded fallbacks", () => {
	const fixture = "tests/local/captured-callback-inlining.js";
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const outDir = mkdtempSync(join(tmpdir(), "mal-captured-callback-inlining-"));
	try {
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "captured-callback-inlining",
			config: resolveBuildConfig({
				engine: { primordials: "locked", eval: false, realms: false },
			}),
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
