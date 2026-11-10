import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

it("charges body copies, requests collection and releases their ownership", () => {
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-web-body-pressure-"));
	try {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "web-body-pressure",
			mainFile: "tests/fixtures/web-body-pressure/main.c",
			evalEnabled: false,
			realmsEnabled: false,
			intlEnabled: false,
			outDir,
		});
		expect(runToStdout(binary, { env: { MAL_GC_VERIFY: "1" } })).toBe(
			"web-body-pressure PASS\n",
		);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});
