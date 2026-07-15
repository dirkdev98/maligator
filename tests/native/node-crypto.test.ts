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

// node:crypto is behind surface.node, so the fixture is linked against the
// node-on artifacts (-DMAL_NODE=1) prewarmed by globalSetup. The fixture self-reports
// "RESULT N/N" (no "FAIL:" lines) over SHA-256 vectors, UUID v4 format / variant /
// uniqueness, strict argument validation, and detached/resizable buffer safety.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-crypto-"));

describe("node:crypto (surface.node)", () => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/node-crypto.mts",
			name: "node-crypto",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
	});

	it("passes compiled", () => {
		assertResultPass(runToStdout(bin));
	});

	it("passes under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(bin, { env: STRESS_ENV }));
	});
});
