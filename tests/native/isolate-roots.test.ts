import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const config = resolveBuildConfig({ surface: { webPlatform: true, node: false } });

for (const compiled of [true, false]) {
	it(`keeps independent root state after the last Worker joins (${compiled ? "native" : "interpreted"})`, () => {
		const directory = mkdtempSync(path.join(tmpdir(), "mal-isolate-roots-"));
		try {
			const binary = buildNativeBinary({
				fixture: "tests/fixtures/isolate-worker-roots/main.mts",
				mainFile: "tests/fixtures/isolate-worker-roots/main.c",
				name: `isolate-roots-${compiled ? "native" : "interpreted"}`,
				outDir: directory,
				compiled,
				config,
			});
			const invocation = resolveHarnessExecutionInvocation(binary);
			const result = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				env: { ...process.env, ...STRESS_ENV },
				timeout: scaledNativeRunTimeoutMs(30_000, STRESS_ENV),
			});
			if (result.error !== undefined) throw result.error;
			expect(
				result.status,
				result.stderr || result.stdout || result.signal || "no exit status",
			).toBe(0);
			expect(result.stdout).toBe("isolate roots PASS\n");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 300_000);
}
