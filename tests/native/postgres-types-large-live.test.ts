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

describe("postgres.js types and large objects", () => {
	it.runIf(process.env.MAL_POSTGRES_TYPES_LIVE === "1")(
		"covers built-in/custom types, transforms, session probing, large objects, and teardown",
		() => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-postgres-types-"));
			const binaries = [true, false].map((compiled) =>
				buildNativeBinary({
					fixture: "tests/fixtures/postgres-js/types-large.mjs",
					name: compiled
						? "postgres-types-live-compiled"
						: "postgres-types-live-interpreted",
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
