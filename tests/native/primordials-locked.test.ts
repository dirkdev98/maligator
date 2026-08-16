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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-primordials-locked-"));
const config = resolveBuildConfig({
	engine: {
		primordials: "locked",
		eval: true,
		realms: true,
		regexp: true,
		temporal: true,
		intl: { enabled: true },
	},
	surface: { webPlatform: true },
});

describe("engine.primordials: locked", () => {
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/primordials-locked.js",
			name: "primordials-locked-compiled",
			mainFile: HOST_MAIN,
			outDir,
			config,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/primordials-locked.js",
			name: "primordials-locked-interpreted",
			compiled: false,
			mainFile: HOST_MAIN,
			outDir,
			config,
		});
	});

	it("enforces the same contract in compiled and interpreted code", () => {
		assertResultPass(runToStdout(compiled));
		assertResultPass(runToStdout(interpreted));
	});

	it("holds under GC stress", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV, timeoutMs: 60_000 }));
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV, timeoutMs: 60_000 }));
	});
});
