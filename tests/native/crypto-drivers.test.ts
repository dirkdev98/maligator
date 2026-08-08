import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	ARGON2_MAIN,
	assertPassLine,
	buildNativeBinary,
	ENTROPY_MAIN,
	runToStdout,
	SECRET_BUFFER_MAIN,
	STRESS_ENV,
} from "../../src/test-harness.ts";

// C-driver acceptance tests for the crypto host layer: the Argon2 worker pool's
// lifecycle (exactly-once terminals, reactor retention, saturation,
// cancellation, shutdown, the memory ceiling, a start that creates no workers),
// the CSPRNG boundary itself, and the scrub a secret-bearing ArrayBuffer store
// gets before it is released. None of it is observable from JavaScript.
//
// Kept out of drivers.test.ts because the Argon2 driver needs the node-enabled
// archive, and that file runs inside the smoke tier's fixed time budget.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-crypto-drivers-"));

const DRIVERS = [
	// The Argon2 pool links the Rust backend, which is behind surface.node.
	{ tag: "argon2test", mainFile: ARGON2_MAIN, nodeEnabled: true },
	{ tag: "entropytest", mainFile: ENTROPY_MAIN, nodeEnabled: false },
	// The backing-store contract is an engine one; node is off to keep it there.
	{ tag: "secretbuffertest", mainFile: SECRET_BUFFER_MAIN, nodeEnabled: false },
];

describe.each(DRIVERS)("$tag", ({ tag, mainFile, nodeEnabled }) => {
	let binary: string;
	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: tag,
			mainFile,
			outDir,
			nodeEnabled,
		});
	});

	it("passes compiled", () => {
		assertPassLine(runToStdout(binary), tag);
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertPassLine(runToStdout(binary, { env: STRESS_ENV }), tag);
	});
});
