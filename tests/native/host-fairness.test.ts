import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
	withServer,
} from "../../src/test-harness.ts";

for (const compiled of [true, false]) {
	it(`services competing sources and preserves reactor checkpoints (${compiled ? "native" : "interpreted"})`, async () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-host-fairness-"));
		try {
			const messages = buildNativeBinary({
				fixture: "tests/local/host-fairness/main.mjs",
				name: `host-fairness-${compiled ? "native" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
			});
			const server = buildNativeBinary({
				fixture: "tests/local/host-fairness/server.mjs",
				name: `reactor-checkpoint-${compiled ? "native" : "interpreted"}`,
				outDir,
				compiled,
				nodeEnabled: true,
				webPlatformEnabled: true,
			});
			for (const env of [{}, STRESS_ENV]) {
				expect(runToStdout(messages, { env, timeoutMs: 10_000 })).toBe(
					"host-fairness PASS\n",
				);
				await withServer(server, env, async (base) => {
					const response = await fetch(base);
					expect(await response.text()).toBe("checkpoint");
				});
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 300_000);
}
