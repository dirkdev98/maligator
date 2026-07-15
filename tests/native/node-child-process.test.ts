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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-child-process-"));
const fixture = "tests/local/node-child-process.mts";

describe("node:child_process execFileSync (POSIX)", () => {
	// This fixture reports through stdout, so closing 0/1/2 in the launched test
	// process would also remove the harness result channel. The host implementation
	// documents and enforces the testable invariant instead: every pipe endpoint is
	// moved above fd 2 before any child-side dup2 sequence begins.
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture,
			name: "node-child-process-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "node-child-process-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("passes compiled", () => {
		assertResultPass(runToStdout(compiled, { timeoutMs: 30000 }));
	});

	it("passes interpreted", () => {
		assertResultPass(runToStdout(interpreted, { timeoutMs: 30000 }));
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV, timeoutMs: 30000 }));
	});
});
