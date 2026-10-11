import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-crypto-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

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

	it.each([
		["focused compiled", () => compiled],
		["focused interpreted", () => interpreted],
		["pinned compiled", () => pinnedCompiled],
		["pinned interpreted", () => pinnedInterpreted],
	] as const)(
		"passes %s under GC stress",
		(_name, binary) => {
			assertResultPass(runToStdout(binary(), { env: STRESS_ENV }));
		},
		scaledNativeRunTimeoutMs(20_000, { ...process.env, ...STRESS_ENV }) + 1000,
	);
});
