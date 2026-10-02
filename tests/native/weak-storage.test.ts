import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	assertPassLine,
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	runToStdout,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-weak-storage-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("specialized weak collection storage", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		({ compiled, interpreted } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/weak-storage.js",
			name: "weak-storage",
			mainFile: HOST_MAIN,
			outDir,
		}));
	}, 600_000);
	for (const mode of ["compiled", "interpreted"] as const) {
		for (const stress of [false, true]) {
			it(`preserves weak owner behavior in ${mode}, GC stress=${stress}`, () => {
				assertPassLine(
					runToStdout(mode === "compiled" ? compiled : interpreted, {
						env: { MAL_HOST_GC: "1", MAL_GC_VERIFY: "1", ...(stress ? STRESS_ENV : {}) },
					}),
					"weak-storage",
				);
			});
		}
	}
	it("bounds direct bucket churn and preserves conditional minor and major edges", () => {
		const binary = buildNativeBinary({
			fixture: "tests/local/fibertest_stub.js",
			name: "weak-storage-abi",
			mainFile: "tests/fixtures/weak-storage/main.c",
			outDir,
		});
		const invocation = resolveHarnessExecutionInvocation(binary);
		const result = spawnSync(invocation.executable, invocation.args, {
			env: {
				...process.env,
				MAL_GC_VERIFY: "1",
				MAL_GC_STRESS: "0",
				MAL_GC_MAJOR_EVERY: "8",
				MAL_GC_STATS: "1",
			},
			encoding: "utf8",
			timeout: scaledNativeRunTimeoutMs(120_000),
		});
		if (result.error !== undefined) throw result.error;
		expect(result.status, result.stderr || result.stdout).toBe(0);
		expect(result.stdout).toBe("weak-storage ABI PASS\n");
		expect(Number(result.stderr.match(/\bminor=(\d+)/)?.[1] ?? 0)).toBeGreaterThan(0);
	});
});
