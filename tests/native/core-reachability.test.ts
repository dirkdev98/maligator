import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-core-reachability-"));
const config = resolveBuildConfig({});

describe("source-closed Core function reachability", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/core-reachability.mjs",
			name: "core-reachability-compiled",
			mainFile: HOST_MAIN,
			outDir,
			config,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/core-reachability.mjs",
			name: "core-reachability-interpreted",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
			config,
		});
	});

	it("preserves the live program in compiled and interpreted output", () => {
		assertResultPass(runToStdout(compiled));
		assertResultPass(runToStdout(interpreted));
	});

	it("preserves the compact graph under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});
});
