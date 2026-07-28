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

describe("postgres.js query and transaction APIs", () => {
	it.runIf(process.env.MAL_POSTGRES_QUERY_LIVE === "1")(
		"covers transactions, builders, cursors, result modes, and file queries",
		() => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-postgres-query-api-"));
			const binaries = [true, false].map((compiled) =>
				buildNativeBinary({
					fixture: "tests/fixtures/postgres-js/query-api.mjs",
					name: compiled
						? "postgres-query-api-live-compiled"
						: "postgres-query-api-live-interpreted",
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
