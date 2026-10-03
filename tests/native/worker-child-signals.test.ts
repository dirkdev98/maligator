import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

for (const compiled of [true, false]) {
	it(`children of owner and worker threads keep default signal handling (${compiled ? "native" : "interpreted"})`, () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-worker-child-signals-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/fixtures/worker-child-signals/main.mjs",
				name: `worker-child-signals-${compiled ? "native" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
			expect(runToStdout(binary, { timeoutMs: 30_000 })).toBe(
				"worker-child-signals PASS\n",
			);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});
}
