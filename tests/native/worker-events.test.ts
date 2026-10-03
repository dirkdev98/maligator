import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

for (const compiled of [true, false]) {
	it(`captures async event contexts and settles once (${compiled ? "native" : "interpreted"})`, () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-worker-events-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/local/worker-events/main.mjs",
				name: `worker-events-${compiled ? "native" : "interpreted"}`,
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				compiled,
			});
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe("worker-events PASS\n");
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 300_000);
}
