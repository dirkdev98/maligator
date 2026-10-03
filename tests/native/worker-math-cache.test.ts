import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

for (const compiled of [true, false]) {
	it(`isolates indirect Math call caches (${compiled ? "native" : "interpreted"})`, () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-worker-math-cache-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/worker-math-cache/main.mjs",
				name: `worker-math-cache-${compiled ? "native" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
			if (compiled) {
				const workerCode = readdirSync(outDir)
					.filter((file) => file.includes(".worker-") && file.endsWith(".c"))
					.map((file) => readFileSync(path.join(outDir, file), "utf8"))
					.join("\n");
				expect(workerCode).toContain("static MAL_ISOLATE_LOCAL MalMathUnaryOp __math_");
				expect(workerCode).toContain("static MAL_ISOLATE_LOCAL MalMathBinaryOp __math_");
			}
			expect(runToStdout(binary, { timeoutMs: 30_000 })).toBe("worker-math-cache PASS\n");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 300_000);
}
