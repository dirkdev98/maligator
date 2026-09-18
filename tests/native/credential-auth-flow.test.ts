import { execFileSync } from "node:child_process";
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

// Run under installed Node as well because every API in this integration flow
// is expected to have matching Maligator and Node behavior.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-credential-auth-"));
const FIXTURE = "tests/local/credential-auth-flow.mts";

describe("credential authentication flow (surface.node)", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: FIXTURE,
			name: "credential-auth-flow-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: FIXTURE,
			name: "credential-auth-flow-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("passes compiled and interpreted", () => {
		assertResultPass(runToStdout(compiled));
		assertResultPass(runToStdout(interpreted));
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV, timeoutMs: 60_000 }));
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV, timeoutMs: 60_000 }));
	}, 120_000);

	it("passes under the installed Node", () => {
		assertResultPass(execFileSync(process.execPath, [FIXTURE], { encoding: "utf-8" }));
	});
});
