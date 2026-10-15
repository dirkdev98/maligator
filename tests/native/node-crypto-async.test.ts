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

// Over-policy allocations are JavaScript errors here but can SIGKILL Node.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-crypto-async-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

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

	// Pending callbacks survive only through crypto_scan_roots before the drain.
	it.each(["compiled", "interpreted"] as const)(
		"passes %s under MAL_GC_STRESS + MAL_GC_VERIFY",
		(backend) => {
			assertResultPass(
				runToStdout(backend === "compiled" ? compiled : interpreted, {
					env: STRESS_ENV,
				}),
			);
		},
		scaledNativeRunTimeoutMs(undefined, { ...process.env, ...STRESS_ENV }) + 5000,
	);
});
