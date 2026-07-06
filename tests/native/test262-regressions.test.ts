import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it } from "vitest";
import { TEST262_METADATA } from "../../src/test262/constants.ts";

// Reuses the full test262 runner (harness composition, negative/async handling,
// strict + sloppy fold) scoped to the committed regression manifest, and compares
// against the committed scripts/test262.json baseline with --check. Compiled mode
// only — the interpreter/stress GC modes are not run here (see gate history). The
// corpus is an external checkout (`npm run test262` populates it); skip cleanly
// when it isn't present so bare `npm test` still works.
const corpusReady =
	existsSync(TEST262_METADATA.cacheFile) && existsSync(TEST262_METADATA.path);

describe.skipIf(!corpusReady)("test262 regression manifest", () => {
	it("curated common-case tests still pass (no regression vs baseline)", () => {
		try {
			execFileSync(
				"node",
				["scripts/test262.ts", "--manifest", "tests/test262-regressions.txt", "--check"],
				{ encoding: "utf-8", maxBuffer: 128 * 1024 * 1024, timeout: 600_000 },
			);
		} catch (error) {
			const e = error as { stdout?: string; stderr?: string };
			// --check exits non-zero on a regression; the runner logs the offending
			// paths under "REGRESSIONS (n):" — surface them.
			throw new Error(
				`test262 regression manifest failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`,
			);
		}
	}, 600_000);
});
