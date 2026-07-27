import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("postgres.js feature matrix", () => {
	it.runIf(process.env.MAL_POSTGRES_FEATURES_LIVE === "1")(
		"covers prepared, pool, cancellation, COPY, notifications, failover, and reconnect",
		() => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-postgres-features-"));
			const binaries = [true, false].map((compiled) =>
				buildNativeBinary({
					fixture: "tests/fixtures/postgres-js/features.mjs",
					name: compiled
						? "postgres-features-live-compiled"
						: "postgres-features-live-interpreted",
					mainFile: HOST_MAIN,
					outDir,
					nodeEnabled: true,
					webPlatformEnabled: false,
					compiled,
				}),
			);
			for (const binary of binaries) {
				assertResultPass(runToStdout(binary, { timeoutMs: 60_000 }));
				assertResultPass(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 60_000 }));
			}
		},
		300_000,
	);
});
