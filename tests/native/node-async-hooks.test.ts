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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-async-hooks-"));

describe("node:async_hooks AsyncResource", () => {
	let compiled: string;
	let interpreted: string;
	let expressFoundations: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/node-async-hooks.mjs",
			name: "node-async-hooks-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/node-async-hooks.mjs",
			name: "node-async-hooks-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
		expressFoundations = buildNativeBinary({
			fixture: "tests/fixtures/express-5/node-foundations-smoke.cjs",
			name: "node-express-body-compat",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	});

	it("passes compiled", () => {
		assertResultPass(runToStdout(compiled));
	});

	it("passes interpreted", () => {
		assertResultPass(runToStdout(interpreted));
	});

	it("supports pinned on-finished and iconv-lite consumers", () => {
		assertResultPass(runToStdout(expressFoundations));
	});

	it("passes compiled under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
	});

	it("passes interpreted under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});

	it("passes the pinned foundations smoke under GC stress", () => {
		assertResultPass(runToStdout(expressFoundations, { env: STRESS_ENV }));
	});
});
