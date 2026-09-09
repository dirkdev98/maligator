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
		"preserves primitive argument wrapper coercions and effects with %s primordials",
		(primordials) => {
			const fixture = "tests/local/wrapper-primitive-arguments-consumers.mjs";
			const expected = execFileSync(process.execPath, [fixture], {
				encoding: "utf8",
			});
			const outDir = mkdtempSync(
				path.join(os.tmpdir(), "mal-wrapper-primitive-arguments-"),
			);
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "wrapper-primitive-arguments",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
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
	it.each(["locked", "mutable"] as const)(
		"preserves numeric Math wrapper coercions and effects with %s primordials",
		(primordials) => {
			const fixture = "tests/local/wrapper-math-consumers.mjs";
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-wrapper-math-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "wrapper-math",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
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
	it.each(["locked", "mutable"] as const)(
		"preserves wrapper coercion consumers and identity boundaries with %s primordials",
		(primordials) => {
			const fixture = "tests/local/wrapper-coercion-consumers.mjs";
			const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-wrapper-coercions-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "wrapper-coercions",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
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
	it.each(["locked", "mutable"] as const)(
		"preserves wrapper predicate consumers and conversion boundaries with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-wrapper-predicates-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/wrapper-predicate-consumers.mjs",
					name: "wrapper-predicates",
					config: resolveBuildConfig({
						engine: { primordials, eval: false, realms: false },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe("wrapper predicate consumers passed\n");
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
						"wrapper predicate consumers passed\n",
					);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it("keeps the embedded compiler independent of replaced user globals", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-eval-replaced-globals-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture: "tests/local/eval-replaced-globals.mjs",
				name: "eval-globals",
				config: resolveBuildConfig({
					engine: { primordials: "mutable", eval: true, realms: false },
				}),
				outDir,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe("eval replaced globals passed\n");
				// The embedded compiler reaches many safepoints per source expression.
				expect(
					runToStdout(binary, {
						env: { MAL_GC_STRESS: "1000", MAL_GC_VERIFY: "1" },
						timeoutMs: 60_000,
					}),
				).toBe("eval replaced globals passed\n");
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 600_000);
	it("preserves locked global writes under GC stress without optional features", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-locked-global-bindings-"));
		try {
			const pair = buildBackendPairFromOneProgramImage({
				fixture: "tests/local/locked-global-bindings.mjs",
				name: "bindings",
				config: resolveBuildConfig({
					engine: { primordials: "locked", eval: false, realms: false },
				}),
				outDir,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe("locked global bindings passed\n");
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
					"locked global bindings passed\n",
				);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 600_000);
	it.each([false, true])(
		"preserves guarded Number predicates and noncoercing arguments with realms=%s",
		(realms) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-predicate-guards-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/guarded-number-predicates.mjs",
					name: "guards",
					config: resolveBuildConfig({ engine: { primordials: "mutable", realms } }),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe("number predicate guards passed\n");
					expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } })).toBe(
						"number predicate guards passed\n",
					);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it.each([false, true])(
		"preserves guarded number formatting and callee mutations with realms=%s",
		(realms) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-number-guards-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/guarded-number-format.mjs",
					name: "guards",
					config: resolveBuildConfig({ engine: { primordials: "mutable", realms } }),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe("number formatting guards passed\n");
					expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } })).toBe(
						"number formatting guards passed\n",
					);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
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

	it.each(["locked", "mutable"] as const)(
		"preserves exact sum and iterator closing with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-static-sum-"));
			try {
				const pair = buildBackendPairFromOneProgramImage({
					fixture: "tests/local/static-math-sum.mjs",
					name: "sum",
					config: resolveBuildConfig({ engine: { primordials } }),
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
		},
		600_000,
	);

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
