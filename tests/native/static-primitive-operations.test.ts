import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("primitive operation differential", () => {
	it.each(["locked", "mutable"] as const)(
		"preserves primitive function identities and rejected construction with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-identities-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/static-primitive-identities.mjs",
					name: "identities",
					config: resolveBuildConfig({ engine: { primordials } }),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe("primitive identities passed\n");
					expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } })).toBe(
						"primitive identities passed\n",
					);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each([false, true])(
		"preserves locale case effects and prepared parameters with Intl=%s",
		(enabled) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-locale-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/static-string-locale.mjs",
					name: "locale",
					config: resolveBuildConfig({
						engine: { primordials: "locked", intl: { enabled, features: ["collator"] } },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted])
					expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } })).toBe(
						"locale cases passed\n",
					);
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);

	it("preserves exact sum and iterator closing through direct dispatch", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-sum-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture: "tests/local/static-math-sum.mjs",
				name: "sum",
				config: resolveBuildConfig({ engine: { primordials: "locked" } }),
				outDir,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
					"1\n-0\n-0\nTypeError\ninr\n",
				);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 600_000);

	it("matches constant radix spellings to the target formatter across all bases and binary64 extremes", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-radix-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture: "tests/local/static-number-radix.mjs",
				name: "radix",
				config: resolveBuildConfig({ engine: { primordials: "locked" } }),
				outDir,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe("280 target radix cases passed\n");
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
					"280 target radix cases passed\n",
				);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 600_000);
	it.each(["locked", "mutable"] as const)(
		"preserves values and coercion order with %s primordials",
		(primordials) => {
			const fixture = "tests/local/static-primitive-operations.mjs";
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-primitives-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "primitives",
					config: resolveBuildConfig({ engine: { primordials } }),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } })).toBe(
						expected,
					);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
});
