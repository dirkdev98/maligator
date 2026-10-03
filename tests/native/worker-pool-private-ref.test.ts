import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

for (const compiled of [true, false]) {
	it(`keeps pool worker ownership stable under prototype edits (${compiled ? "native" : "interpreted"})`, () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-worker-pool-ref-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/workers-runtime/pool-private-ref.mjs",
				name: `worker-pool-private-ref-${compiled ? "native" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
			expect(runToStdout(binary, { timeoutMs: 10_000 })).toBe("pool-private-ref PASS\n");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 300_000);
}
