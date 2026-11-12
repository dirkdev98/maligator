import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-node-test-"));
let binaries: { compiled: string; interpreted: string };
beforeAll(() => {
	binaries = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/node-test.mjs",
		name: "node-test",
		mainFile: HOST_MAIN,
		outDir,
		nodeEnabled: true,
	});
});
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function run(binary: string, mode: string, stress = false) {
	const invocation = resolveHarnessExecutionInvocation(binary);
	return spawnSync(invocation.executable, [...invocation.args, mode], {
		encoding: "utf8",
		timeout: 15_000,
		env: { ...process.env, ...(stress ? STRESS_ENV : {}) },
	});
}

it.each(["compiled", "interpreted"] as const)(
	"runs node:test assertions, suites and cleanup through ESM and require in %s code",
	(backend) => {
		for (const stress of [false, true]) {
			const result = run(binaries[backend], "pass", stress);
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toContain("TODO EXECUTED");
			expect(result.stdout).toContain("NODE TEST PASS");
			expect(result.stdout).toContain("OPTIONS CALLBACK PASS");
		}
	},
);

it.each([
	"plan",
	"options-plan",
	"options-fn",
	"body",
	"cleanup",
	"idle",
	"timeout",
	"undefined",
])("fails %s work and completes its cleanup", (mode) => {
	for (const backend of ["compiled", "interpreted"] as const) {
		const result = run(binaries[backend], mode);
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr || result.stdout).toBe(1);
		expect(result.stdout).toContain("CLEANUP RAN");
		expect(result.stdout).not.toContain("UNEXPECTED LATER CLEANUP");
	}
});
