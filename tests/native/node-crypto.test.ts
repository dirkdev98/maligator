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

// node:crypto is behind surface.node, so these fixtures link against the node-on
// artifacts (-DMAL_NODE=1) prewarmed by globalSetup.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-crypto-"));

describe("node:crypto (surface.node)", () => {
	let compiled: string;
	let interpreted: string;
	let pinnedCompiled: string;
	let pinnedInterpreted: string;
	beforeAll(() => {
		compiled = buildNativeBinary({
			fixture: "tests/local/node-crypto.mts",
			name: "node-crypto-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: "tests/local/node-crypto.mts",
			name: "node-crypto-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
		pinnedCompiled = buildNativeBinary({
			fixture: "tests/fixtures/express-5/crypto-smoke.cjs",
			name: "node-crypto-pinned-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		pinnedInterpreted = buildNativeBinary({
			fixture: "tests/fixtures/express-5/crypto-smoke.cjs",
			name: "node-crypto-pinned-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("passes focused semantics compiled and interpreted", () => {
		assertResultPass(runToStdout(compiled));
		assertResultPass(runToStdout(interpreted));
	});

	it("loads pinned unmodified etag and cookie-signature", () => {
		assertResultPass(runToStdout(pinnedCompiled));
		assertResultPass(runToStdout(pinnedInterpreted));
	});

	it("passes focused and pinned fixtures under GC stress", () => {
		for (const binary of [compiled, interpreted, pinnedCompiled, pinnedInterpreted]) {
			assertResultPass(runToStdout(binary, { env: STRESS_ENV }));
		}
	});
});
