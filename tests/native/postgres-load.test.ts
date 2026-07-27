import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-postgres-load-"));

describe("postgres.js package loading", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = ["load.mjs", "load.cjs"].flatMap((fixture) =>
			[true, false].map((compiled) =>
				buildNativeBinary({
					fixture: `tests/fixtures/postgres-js/${fixture}`,
					name: `postgres-${fixture}-${compiled ? "compiled" : "interpreted"}`,
					mainFile: HOST_MAIN,
					outDir,
					nodeEnabled: true,
					webPlatformEnabled: false,
					compiled,
				}),
			),
		);
	}, 600_000);

	it("loads and constructs the unchanged ESM and CommonJS releases", () => {
		for (const binary of binaries) assertResultPass(runToStdout(binary));
	});

	it("keeps both package graphs alive under GC stress", () => {
		for (const binary of binaries) {
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
		}
	});
});
