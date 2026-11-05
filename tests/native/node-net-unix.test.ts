import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildNativeBinary,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-node-net-unix-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const fixture = "tests/local/node-net-unix.mjs";
const env = { MAL_SOCKET_CWD: realpathSync(outDir) };

describe("node:net Unix domain sockets", () => {
	let expected: string;
	let compiled: string;
	let interpreted: string;

	beforeAll(() => {
		expected = execFileSync(
			process.execPath,
			["--no-deprecation", path.resolve(fixture)],
			{
				encoding: "utf8",
				cwd: outDir,
				env: { ...process.env, ...env },
			},
		);
		compiled = buildNativeBinary({
			fixture,
			name: "node-net-unix-compiled",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
		});
		interpreted = buildNativeBinary({
			fixture,
			name: "node-net-unix-interpreted",
			mainFile: HOST_MAIN,
			outDir,
			nodeEnabled: true,
			compiled: false,
		});
	});

	it("matches Node compiled", () => {
		expect(runToStdout(compiled, { cwd: outDir, env, timeoutMs: 30000 })).toBe(expected);
	});

	it("matches Node interpreted", () => {
		expect(runToStdout(interpreted, { cwd: outDir, env, timeoutMs: 30000 })).toBe(
			expected,
		);
	});

	it("matches Node under MAL_GC_STRESS + MAL_GC_VERIFY", () => {
		expect(
			runToStdout(compiled, {
				cwd: outDir,
				env: { ...env, ...STRESS_ENV },
				timeoutMs: 60000,
			}),
		).toBe(expected);
	});
});
