import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import {
	assertPassLine,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each([false, true])(
	"materializes and reclaims private graphs with realms %s",
	(realmsEnabled) => {
		const outDir = mkdtempSync(join(tmpdir(), "mal-materialization-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/fibertest_stub.js",
				name: "literal-materialization",
				mainFile: "runtime/literal_materialization_test_main.c",
				realmsEnabled,
				outDir,
			});
			for (const env of [{}, STRESS_ENV])
				assertPassLine(runToStdout(binary, { env }), "literal-materialization");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	},
	600000,
);
