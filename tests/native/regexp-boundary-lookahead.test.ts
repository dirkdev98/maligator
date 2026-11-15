import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/regexp-boundary-lookahead.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-regexp-boundary-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

it("preserves terminal lookahead captures, lastIndex and exec overrides", () => {
	const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
	const pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "regexp-boundary-lookahead",
		outDir,
		mainFile: HOST_MAIN,
		config: resolveBuildConfig({
			engine: { primordials: "mutable", eval: false, realms: false },
		}),
		environment: { ...process.env, MAL_PERF_STATS: "1" },
	});
	const environments = ["MAL_ASAN", "MAL_UBSAN", "MAL_TSAN"].some(
		(key) => process.env[key] === "1",
	)
		? [{}]
		: [{}, STRESS_ENV];
	for (const binary of [pair.compiled, pair.interpreted]) {
		for (const stress of environments) {
			expect(runToStdout(binary, { env: stress, timeoutMs: 60_000 })).toBe(expected);
		}
	}
	const measured = spawnSync(pair.compiled, [], {
		encoding: "utf8",
		timeout: 60_000,
		env: { ...process.env, MAL_PERF_STATS: "1" },
	});
	expect(measured.status, measured.stderr).toBe(0);
	expect(measured.stdout).toBe(expected);
	expect(Number(measured.stderr.match(/fast_exec_calls=(\d+)/)?.[1])).toBeGreaterThan(0);
});
