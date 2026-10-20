import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-direct-closure-owner-calls-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const fixture = "tests/local/direct-closure-owner-calls.mjs";

describe("direct closures called by their owner", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, ["--no-deprecation", fixture], {
			encoding: "utf8",
		});
		compiled = buildNativeBinary({
			fixture,
			name: "direct-closure-owner-calls-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "direct-closure-owner-calls-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("matches Node compiled", () => {
		expect(runToStdout(compiled, { timeoutMs: 30000 })).toBe(expected);
	});

	it("matches Node interpreted", () => {
		expect(runToStdout(interpreted, { timeoutMs: 30000 })).toBe(expected);
	});

	it("matches Node under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		expect(runToStdout(compiled, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
	});
});
