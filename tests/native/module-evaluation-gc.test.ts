import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

test.each([true, false])(
	"collects during startup, imports and resumed module ancestors (compiled=%s)",
	(compiled) => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-module-gc-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/fixtures/module-evaluation-gc/entry.mjs",
				mainFile: "tests/fixtures/module-evaluation-gc/main.c",
				name: `module-evaluation-gc-${compiled ? "compiled" : "interpreted"}`,
				outDir,
				compiled,
			});
			expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_GC_STATS: "1" } })).toBe(
				"module-evaluation-gc PASS\n",
			);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	},
	300_000,
);
