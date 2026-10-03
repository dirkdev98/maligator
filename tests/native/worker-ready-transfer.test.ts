import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

for (const compiled of [true, false]) {
	it(`delivers queued messages after a started port changes isolates (${compiled ? "native" : "interpreted"})`, () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-worker-ready-transfer-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/worker-ready-transfer/main.mjs",
				name: `worker-ready-transfer-${compiled ? "native" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
			expect(runToStdout(binary, { timeoutMs: 30_000 })).toBe(
				"worker-ready-transfer PASS\n",
			);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 300_000);
}
