import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertResultPass,
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-vm-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const fixture = "tests/local/node-vm.mjs";

describe("node:vm contexts, scripts and compiled functions", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(process.execPath, ["--no-deprecation", fixture], {
			encoding: "utf8",
		});
		compiled = buildNativeBinary({
			fixture,
			name: "node-vm-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "node-vm-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("matches Node compiled", () => {
		expect(runToStdout(compiled)).toBe(expected);
	});

	it("matches Node interpreted", () => {
		expect(runToStdout(interpreted)).toBe(expected);
	});

	it("matches Node under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		expect(runToStdout(compiled, { env: STRESS_ENV, timeoutMs: 60000 })).toBe(expected);
	});
});

describe("node:v8 flags reaching node:vm contexts", () => {
	let bin: string;
	beforeAll(() => {
		bin = buildNativeBinary({
			fixture: "tests/local/node-vm.mts",
			name: "node-vm-v8",
			outDir,
			nodeEnabled: true,
			evalEnabled: true,
			realmsEnabled: true,
		});
	});

	it("runs code in fresh contexts and exposes explicit GC", () => {
		assertResultPass(runToStdout(bin));
	});

	it("keeps context results alive under GC stress", () => {
		assertResultPass(runToStdout(bin, { env: STRESS_ENV }));
	});
});
