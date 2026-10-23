import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

function expectCollectionsWhileEvaluating(
	entry: string,
	name: string,
	compiled: boolean,
): void {
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-module-gc-"));
	try {
		const binary = buildNativeBinary({
			fixture: `tests/local/module-evaluation-gc/${entry}`,
			mainFile: "tests/local/module-evaluation-gc/main.c",
			name: `${name}-${compiled ? "compiled" : "interpreted"}`,
			outDir,
			compiled,
		});
		expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_GC_STATS: "1" } })).toBe(
			"module-evaluation-gc PASS\n",
		);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}

test.each([true, false])(
	"collects during startup, imports and resumed module ancestors (compiled=%s)",
	(compiled) => {
		expectCollectionsWhileEvaluating("entry.mjs", "module-evaluation-gc", compiled);
	},
	300_000,
);

test.each([true, false])(
	"collects while required CommonJS module bodies run (compiled=%s)",
	(compiled) => {
		expectCollectionsWhileEvaluating(
			"commonjs-entry.cjs",
			"commonjs-evaluation-gc",
			compiled,
		);
	},
	300_000,
);
