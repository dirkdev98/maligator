import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("static-value baseline differential", () => {
	it.each([
		["tests/local/static-values-baseline.mjs", "locked"],
		["tests/local/static-values-semantics.mjs", "locked"],
		["tests/local/static-values-semantics.mjs", "mutable"],
	] as const)(
		"preserves semantic boundaries in %s with %s primordials",
		(fixture, primordials) => {
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-values-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "baseline",
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
		600_000,
	);
	it("preserves eval escapes and cross-realm borrowing", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-worlds-"));
		try {
			const binaries = [true, false].map((compiled) =>
				buildNativeBinary({
					fixture: "tests/local/static-values-worlds.js",
					name: `worlds-${compiled ? "compiled" : "interpreted"}`,
					compiled,
					mainFile: "runtime/test262_main.c",
					config: resolveBuildConfig({
						engine: {
							eval: true,
							realms: true,
							intl: { enabled: true, features: ["collator"] },
						},
					}),
					outDir,
				}),
			);
			for (const binary of binaries) {
				expect(runToStdout(binary, { env: { MAL_TEST262: "1" } })).toBe(
					"static value world boundaries passed\n",
				);
				expect(
					runToStdout(binary, {
						env: { ...STRESS_ENV, MAL_TEST262: "1" },
						timeoutMs: 180_000,
					}),
				).toBe("static value world boundaries passed\n");
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 600_000);
});
