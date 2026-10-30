import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertResultPass,
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("numeric abstract operations", () => {
	it("preserves explicit precision across binary64 exponents", () => {
		const fixture = "tests/local/number-format-prefix.mjs";
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const outDir = mkdtempSync(join(tmpdir(), "mal-number-format-prefix-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				outDir,
				name: "number-format-prefix",
				nativeStackRoots: "precise",
				config: resolveBuildConfig({
					surface: { node: true },
					engine: { eval: false, realms: false },
				}),
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe(expected);
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	it.each([
		["compiled", true],
		["interpreted", false],
	])(
		"shares pure-number tails in %s mode",
		(_name, compiled) => {
			const binary = buildNativeBinary({
				fixture: "tests/local/numeric-abstract-ops.js",
				name: `numeric-abstract-ops-${compiled ? "compiled" : "interpreted"}`,
				compiled,
			});
			assertResultPass(runToStdout(binary));
			if (compiled) {
				assertResultPass(
					runToStdout(binary, {
						env: { ...STRESS_ENV, MAL_HOST_GC: "1" },
					}),
				);
			}
		},
		600_000,
	);
});
