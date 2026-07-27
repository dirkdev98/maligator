import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

describe("postgres.js live database", () => {
	it.skip("queries the opt-in local PostgreSQL instance", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-postgres-live-"));
		const binary = buildNativeBinary({
			fixture: "tests/fixtures/postgres-js/live.mjs",
			name: "postgres-live",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			webPlatformEnabled: false,
		});
		assertResultPass(runToStdout(binary, { timeoutMs: 30_000 }));
	});
});
