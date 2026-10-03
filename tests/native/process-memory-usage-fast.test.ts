import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { buildNativeBinary, runToStdout, STRESS_ENV } from "../../src/test-harness.ts";

for (const compiled of [true, false]) {
	it(`reports exact live backing ownership (${compiled ? "native" : "interpreted"})`, () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-process-memory-fast-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/process-memory-usage-fast.mjs",
				name: `process-memory-usage-fast-${compiled ? "native" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
			expect(runToStdout(binary, { env: { MAL_HOST_GC: "1" } })).toBe(
				"process-memory-usage-fast PASS\n",
			);
			expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_HOST_GC: "1" } })).toBe(
				"process-memory-usage-fast PASS\n",
			);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 300_000);

	it(`moves backing ownership between isolates (${compiled ? "native" : "interpreted"})`, () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-process-memory-transfer-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/process-memory-usage-transfer/main.mjs",
				name: `process-memory-usage-transfer-${compiled ? "native" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
			for (const env of [{ MAL_HOST_GC: "1" }, { ...STRESS_ENV, MAL_HOST_GC: "1" }]) {
				expect(runToStdout(binary, { env, timeoutMs: 30_000 })).toBe(
					"process-memory-usage-transfer PASS\n",
				);
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 300_000);
}
