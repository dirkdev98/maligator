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

// The authentication vertical slice this issue exists for, driven end to end
// through the compiled surface. Also run under the installed Node, since every
// API the flow touches is one where Maligator and Node agree.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-vonk-auth-"));
const FIXTURE = "tests/local/vonk-auth-flow.mts";

describe("Vonk authentication flow (surface.node)", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: FIXTURE,
			name: "vonk-auth-flow-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: FIXTURE,
			name: "vonk-auth-flow-interpreted",
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
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});

	it("passes under the installed Node", () => {
		assertResultPass(execFileSync(process.execPath, [FIXTURE], { encoding: "utf-8" }));
	});
});
