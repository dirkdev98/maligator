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

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-native-fast-entry-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const fixture = "tests/local/native-fast-entry.mjs";

describe("frameless fast entries", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(
			process.execPath,
			["--no-deprecation", "--expose-gc", fixture],
			{
				encoding: "utf8",
			},
		);
		compiled = buildNativeBinary({
			fixture,
			name: "native-fast-entry-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			evalEnabled: false,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "native-fast-entry-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			evalEnabled: false,
			compiled: false,
		});
	});

	it("matches Node compiled", () => {
		expect(runToStdout(compiled, { env: { MAL_HOST_GC: "1" }, timeoutMs: 30000 })).toBe(
			expected,
		);
	});

	it("matches Node interpreted", () => {
		expect(
			runToStdout(interpreted, { env: { MAL_HOST_GC: "1" }, timeoutMs: 30000 }),
		).toBe(expected);
	});

	it("matches Node under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		expect(
			runToStdout(compiled, {
				env: { ...STRESS_ENV, MAL_HOST_GC: "1" },
				timeoutMs: 60000,
			}),
		).toBe(expected);
	});
});
