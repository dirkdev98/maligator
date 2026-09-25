import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-postgres-load-"));

describe("postgres.js package loading", () => {
	let binaries: Array<string>;

	beforeAll(() => {
		binaries = ["load.mjs", "load.cjs"].flatMap((fixture) => {
			const { compiled, interpreted } = buildBackendPairFromOneProgramImage({
				fixture: `tests/fixtures/postgres-js/${fixture}`,
				name: `postgres-${fixture}`,
				mainFile: HOST_MAIN,
				outDir,
				nodeEnabled: true,
				webPlatformEnabled: false,
			});
			return [compiled, interpreted];
		});
	}, 600_000);

	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("loads and constructs the unchanged ESM and CommonJS releases", () => {
		for (const binary of binaries) assertResultPass(runToStdout(binary));
	});

	it("keeps both package graphs alive under GC stress", () => {
		for (const binary of binaries) {
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
		}
	});
});
