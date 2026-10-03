import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

it("paces isolate owners under process pressure and releases reservations at teardown", () => {
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-process-"));
	try {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "gc-process",
			outDir,
			mainFile: "runtime/gc_process_test_main.c",
		});
		expect(runToStdout(binary, { env: { MAL_GC_PROCESS_BUDGET_BYTES: "1048576" } })).toBe(
			"gc-process PASS\n",
		);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});
