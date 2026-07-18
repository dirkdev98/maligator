import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-identity-"));
const reverseEnv = { MAL_NODE_INSTALL_REVERSE: "1" };
const gcAtExitEnv = { MAL_GC_AT_EXIT: "1" };

describe("Node per-realm installer identity", () => {
	let esmCompiled: string;
	let esmInterpreted: string;
	let cjsCompiled: string;
	let cjsInterpreted: string;
	let allModes: Array<string>;

	beforeAll(() => {
		esmCompiled = buildNativeBinary({
			fixture: "tests/local/node-identity.mjs",
			name: "node-identity-esm-compiled",
			mainFile: "tests/native/node_identity_main.c",
			outDir,
			nodeEnabled: true,
			webPlatformEnabled: false,
		});
		esmInterpreted = buildNativeBinary({
			fixture: "tests/local/node-identity.mjs",
			name: "node-identity-esm-interpreted",
			mainFile: "tests/native/node_identity_main.c",
			outDir,
			nodeEnabled: true,
			webPlatformEnabled: false,
			compiled: false,
		});
		cjsCompiled = buildNativeBinary({
			fixture: "tests/local/node-identity.cjs",
			name: "node-identity-cjs-compiled",
			mainFile: "tests/native/node_identity_main.c",
			outDir,
			nodeEnabled: true,
			webPlatformEnabled: false,
		});
		cjsInterpreted = buildNativeBinary({
			fixture: "tests/local/node-identity.cjs",
			name: "node-identity-cjs-interpreted",
			mainFile: "tests/native/node_identity_main.c",
			outDir,
			nodeEnabled: true,
			webPlatformEnabled: false,
			compiled: false,
		});
		allModes = [esmCompiled, esmInterpreted, cjsCompiled, cjsInterpreted];
	});

	it("preserves compiled and interpreted ESM identities", () => {
		assertResultPass(runToStdout(esmCompiled));
		assertResultPass(runToStdout(esmInterpreted));
	});

	it("preserves compiled and interpreted CommonJS identities", () => {
		assertResultPass(runToStdout(cjsCompiled));
		assertResultPass(runToStdout(cjsInterpreted));
	});

	it("preserves every mode in reverse installer order", () => {
		for (const binary of allModes) {
			assertResultPass(runToStdout(binary, { env: reverseEnv }));
		}
	});

	it("preserves every mode and installer order under GC stress", () => {
		for (const binary of allModes) {
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
			assertResultPass(runToStdout(binary, { env: { ...STRESS_ENV, ...reverseEnv } }));
		}
	});

	it("runs every mode through MAL_GC_AT_EXIT teardown", () => {
		for (const binary of allModes) {
			assertResultPass(runToStdout(binary, { env: gcAtExitEnv }));
		}
	});
});
