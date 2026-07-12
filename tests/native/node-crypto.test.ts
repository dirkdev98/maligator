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

// node:crypto.hash is behind surface.node, so the fixture is linked against the
// node-on archive (-DMAL_NODE=1) prebuilt by globalSetup. The fixture self-reports
// "RESULT N/N" (no "FAIL:" lines) over SHA-256 vectors, strict argument
// validation, and detached/resizable buffer-view safety checks.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-crypto-"));

describe("node:crypto one-shot hash (surface.node)", () => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/node-crypto.mts",
			name: "node-crypto",
			mainFile: HOST_MAIN,
			outDir,
			skipRuntimeBuild: true,
			nodeEnabled: true,
		});
	});

	it("hashes supported inputs and rejects unsupported forms compiled", () => {
		assertResultPass(runToStdout(bin));
	});

	it("hashes supported inputs and rejects unsupported forms under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		assertResultPass(runToStdout(bin, { env: STRESS_ENV }));
	});
});
