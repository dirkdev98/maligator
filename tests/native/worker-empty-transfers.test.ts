import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

for (const compiled of [true, false]) {
	it(`delivers raw and Node messages with their transfer contracts (${compiled ? "native" : "interpreted"})`, () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-worker-empty-transfers-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/worker-empty-transfers/main.mjs",
				name: `worker-empty-transfers-${compiled ? "native" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
			expect(runToStdout(binary, { timeoutMs: 10_000 })).toBe(
				"worker-empty-transfers PASS\n",
			);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 300_000);
}
