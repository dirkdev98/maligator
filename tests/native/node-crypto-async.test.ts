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

// The asynchronous node:crypto surface: the worker pool, operation handles, the
// GC root source that keeps a pending callback alive, and event-loop progress
// during a derivation. Maligator-only (not differential): the fixture's
// allocation-failure case is a JavaScript Error here and a SIGKILL in Node.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-crypto-async-"));

describe("node:crypto async (surface.node)", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/node-crypto-async.mjs",
			name: "node-crypto-async-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/node-crypto-async.mjs",
			name: "node-crypto-async-interpreted",
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

	// This is the run that exercises crypto_scan_roots: a collection at every
	// safepoint lands inside the window where a pending callback is reachable
	// only from the module's root source.
	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(compiled, { env: STRESS_ENV }));
		assertResultPass(runToStdout(interpreted, { env: STRESS_ENV }));
	});
});
