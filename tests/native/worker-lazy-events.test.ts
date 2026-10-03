import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

for (const compiled of [true, false]) {
	it(`delivers live web observers after Node listeners and reclaims unused transfers (${compiled ? "native" : "interpreted"})`, () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-worker-lazy-events-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/worker-lazy-events/main.mjs",
				name: `worker-lazy-events-${compiled ? "native" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
			expect(
				runToStdout(binary, {
					timeoutMs: 10_000,
					env: { MAL_HOST_GC: "1" },
				}),
			).toBe("worker-lazy-events PASS\n");
			expect(
				runToStdout(binary, {
					timeoutMs: 10_000,
					env: { ...STRESS_ENV, MAL_HOST_GC: "1" },
				}),
			).toBe("worker-lazy-events PASS\n");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 300_000);
}
