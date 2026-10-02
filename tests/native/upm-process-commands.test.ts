import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, HOST_MAIN, STRESS_ENV } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-upm-commands-"));
let binary: string;
function run(mode: string, environment: NodeJS.ProcessEnv = {}) {
	return spawnSync(binary, [], {
		encoding: "utf8",
		timeout: 5000,
		env: {
			...process.env,
			FORCE_COLOR: "0",
			UPM_PROCESS_MODE: mode,
			UPM_CHILD_CWD: outDir,
			...environment,
		},
	});
}
beforeAll(() => {
	binary = buildNativeBinary({
		fixture: "tests/local/upm-process-commands.mjs",
		name: "upm-process-commands",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
}, 300_000);
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("UPM commands and diagnostics", () => {
	it.each([{}, STRESS_ENV])(
		"runs inherited commands without blocking and reports launch, exit and signal states",
		(environment) => {
			const result = run("commands", environment);
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			const lines = result.stdout.trim().split("\n");
			expect(lines).toContain("ERROR ENOENT true true");
			expect(lines).toContain("PID true true");
			expect(lines).toContain("ERROR_CLOSE -2 null");
			expect(lines).toContain(`CHILD inherited ${realpathSync(outDir)}`);
			expect(lines).toContain("EXIT 7 null 7 null");
			expect(lines).toContain("NESTED 3");
			expect(lines).toContain("KILL true true");
			expect(lines).toContain("SIGNAL null SIGTERM");
			expect(lines.indexOf("TIMER_WHILE_CHILD")).toBeLessThan(
				lines.indexOf("EXIT 7 null 7 null"),
			);
		},
	);
	it.each([{}, STRESS_ENV])(
		"reports allocated memory, host CPUs and measured event loop delay",
		(environment) => {
			const result = run("diagnostics", environment);
			expect(result.error).toBeUndefined();
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim().split("\n")).toEqual([
				`CPU ${os.cpus().length} true`,
				"MEMORY true true true true true true 131072",
				"REPORT true",
				"ENABLE true false",
				"LAG true true true true false",
				"RESET 0 0",
				"RESOURCES true",
			]);
		},
	);
	it("preserves a throwing spawn listener without emitting exit", () => {
		const result = run("throw-spawn");
		expect(result.error).toBeUndefined();
		expect(result.status).not.toBe(0);
		expect(result.stdout.trim()).toBe("SPAWN_THROW");
	});
	it("does not retain a process for the delay observer", () => {
		const result = run("observer");
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe("OBSERVER_READY");
	});
	it("honors stream color suppression and explicit formatting", () => {
		const result = run("style", { NO_COLOR: "1", FORCE_COLOR: "0" });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual([
			'"hello"',
			'"\\u001b[32mforced\\u001b[39m"',
		]);
	});
	it("lets FORCE_COLOR override NO_COLOR", () => {
		const result = run("style", { NO_COLOR: "1", FORCE_COLOR: "1" });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim().split("\n")[0]).toBe(
			'"\\u001b[1m\\u001b[31mhello\\u001b[39m\\u001b[22m"',
		);
	});
});
