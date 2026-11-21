import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/regexp-closed-results.mjs";
const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
const outDir = mkdtempSync(join(tmpdir(), "mal-regexp-closed-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
describe("closed RegExp results", () => {
	it.each(["mutable", "locked"] as const)(
		"preserves projected and observable results with %s primordials",
		(primordials) => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `regexp-closed-${primordials}`,
				outDir,
				config: resolveBuildConfig({
					engine: {
						primordials,
						eval: false,
						realms: false,
						regexp: true,
						intl: { enabled: false },
						temporal: false,
					},
				}),
			});
			const sanitized = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
				(key) => process.env[key] === "1",
			);
			for (const binary of [pair.compiled, pair.interpreted])
				for (const env of sanitized ? [{}] : [{}, STRESS_ENV])
					expect(runToStdout(binary, { env })).toBe(expected);
		},
	);
});
