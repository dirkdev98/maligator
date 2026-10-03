import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("admits large unique backings, releases quotas and forwards asynchronous worker failures", () => {
	const fixtureDir = "tests/local/worker-transfer-failures";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-worker-transfer-failures-"));
	try {
		const source = readFileSync(`${fixtureDir}/main.mjs`, "utf8");
		writeFileSync(
			path.join(outDir, "main.mjs"),
			source.replace(
				/import\s*\{[^}]+\}\s*from "maligator:workers";/s,
				"const createWorkerUrl = (path, base) => new URL(path, base);",
			),
		);
		copyFileSync(`${fixtureDir}/worker.mjs`, path.join(outDir, "worker.mjs"));
		const expected = new Map<string, string>();
		for (const mode of ["large", "async"]) {
			const result = spawnSync(process.execPath, [path.join(outDir, "main.mjs"), mode], {
				encoding: "utf8",
				timeout: 20_000,
			});
			if (result.error) throw result.error;
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stderr).toBe("");
			expected.set(mode, result.stdout);
		}
		expected.set("quota", "quota-ownership PASS\n");
		expected.set("raw", "raw-errors PASS\n");
		const pair = buildBackendPairFromOneProgramImage({
			fixture: `${fixtureDir}/main.mjs`,
			name: "worker-transfer-failures",
			outDir,
			config: resolveBuildConfig({ surface: { node: true, webPlatform: true } }),
		});
		for (const target of [pair.compiled, pair.interpreted]) {
			const invocation = resolveHarnessExecutionInvocation(target);
			for (const env of [{}, STRESS_ENV]) {
				for (const [mode, stdout] of expected) {
					const result = spawnSync(invocation.executable, [...invocation.args, mode], {
						encoding: "utf8",
						env: { ...process.env, ...env },
						timeout: scaledNativeRunTimeoutMs(20_000, { ...process.env, ...env }),
					});
					if (result.error) throw result.error;
					expect(result.status, `${mode}: ${result.stderr || result.stdout}`).toBe(0);
					expect(result.stderr).toBe("");
					expect(result.stdout).toBe(stdout);
				}
			}
		}
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}, 300_000);
