import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-upm-process-"));
let binary: string;

function run(mode: string, environment: NodeJS.ProcessEnv = {}) {
	return spawnSync(binary, [], {
		encoding: "utf8",
		timeout: 5000,
		env: { ...process.env, ...environment, UPM_PROCESS_MODE: mode },
	});
}

beforeAll(() => {
	binary = buildNativeBinary({
		fixture: "tests/local/upm-process-lifecycle.mjs",
		name: "upm-process-lifecycle",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
}, 300_000);

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("UPM process lifecycle", () => {
	it.each([{}, STRESS_ENV])(
		"loads lazy builtins and preserves callbacks, signals and drain ordering",
		(env) => {
			const result = run("normal", env);
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(3);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toContain("BUILTIN true");
			expect(lines).toContain("UNKNOWN true");
			expect(lines).toContain("IDENTITY true");
			expect(lines).toContain("RUNTIME maligator undefined undefined");
			expect(lines).toContain("STDIO 0 function function undefined");
			expect(lines).toContain("UMASK 63");
			expect(lines).toContain("SIGNAL_VALIDATION true");
			expect(lines).toContain("SIGNAL SIGHUP");
			expect(lines).toContain("REF true true false true true");
			expect(lines).toContain("CALLBACK false");
			expect(lines).toContain("TIMER true");
			expect(lines.slice(-4)).toEqual([
				"BEFORE 1 3",
				"RESCHEDULED",
				"BEFORE 2 3",
				"EXIT 3",
			]);
			expect(result.stdout).not.toMatch(/CLEARED_RAN|BACKGROUND_RAN|EXIT_TIMER_RAN/);
		},
	);

	it("does not retain the process for an unref interval", () => {
		const result = run("unref");
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual(["REF_STATE false", "EXIT 0"]);
	});

	it("uses exitCode for explicit exit and emits exit exactly once", () => {
		const result = run("explicit");
		expect(result.status, result.stderr).toBe(7);
		expect(result.stdout.trim()).toBe("EXIT 7");
	});

	it("reads the final code after synchronous exit listeners", () => {
		const result = run("change-exit");
		expect(result.status, result.stderr).toBe(9);
		expect(result.stdout.trim()).toBe("EXIT 4");
	});

	it("reports EPIPE asynchronously through the callback and error event", async () => {
		const child = spawn(binary, [], {
			env: { ...process.env, UPM_PROCESS_MODE: "epipe" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.destroy();
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const status = await new Promise<number | null>((resolve, reject) => {
			const timeout = setTimeout(() => {
				child.kill("SIGKILL");
				reject(new Error("EPIPE fixture did not exit"));
			}, 5000);
			child.on("error", reject);
			child.on("close", (code) => {
				clearTimeout(timeout);
				resolve(code);
			});
		});
		expect(status, stderr).toBe(0);
		expect(stderr.trim().split("\n")).toEqual([
			"ACCEPTED false",
			"WRITE_ERROR EPIPE",
			"ERROR EPIPE",
		]);
	});
});
