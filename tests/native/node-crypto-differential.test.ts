import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

// Line-for-line agreement with the supported Node release across the
// deterministic node:crypto surface: Argon2 tags on every parameter axis, digest
// and HMAC vectors, encoding round-trips, and the error constructor + message
// for the whole invalid-input table. The fixture documents the three cases
// excluded because Maligator deliberately differs.
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-crypto-diff-"));
const FIXTURE = "tests/local/node-crypto-differential.mts";

describe("node:crypto differential vs the installed Node", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [FIXTURE], { encoding: "utf-8" });
		compiled = buildNativeBinary({
			fixture: FIXTURE,
			name: "node-crypto-differential-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture: FIXTURE,
			name: "node-crypto-differential-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("produces Node's exact output when compiled", () => {
		expect(runToStdout(compiled)).toBe(expected);
	});

	it("produces Node's exact output when interpreted", () => {
		expect(runToStdout(interpreted)).toBe(expected);
	});

	it("produces Node's exact output under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		expect(runToStdout(compiled, { env: STRESS_ENV })).toBe(expected);
	});
});
