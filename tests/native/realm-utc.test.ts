import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import type { BackendPairResult } from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-realm-utc-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const fixture = "tests/local/realm-utc.mjs";
let pair: BackendPairResult;
let owned: BackendPairResult;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "realm-utc",
		outDir,
		mainFile: HOST_MAIN,
		config: resolveBuildConfig({
			engine: { primordials: "mutable", realms: true, eval: false },
		}),
	});
	const fn = pair.programImage.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === "utc",
	)!;
	expect(
		fn.body.instructions.some(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "Date.UTC",
		),
	).toBe(true);
	owned = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/realm-namespace-boundaries.js",
		name: "realm-utc-owned",
		outDir,
		entryGoal: "script",
		entryStrict: false,
		mainFile: "tests/fixtures/realm-namespace-boundaries/main.c",
		environment: { ...process.env, MAL_PERF_STATS: "1" },
		config: resolveBuildConfig({
			engine: { primordials: "mutable", realms: true, eval: false },
		}),
	});
});
describe("UTC arithmetic in the executing realm", () => {
	it.each([
		["returns UTC time values and omitted-argument NaN", "intact"],
		["preserves nonfinite Number results", "nonfinite"],
		["ignores extra argument values", "ignored"],
		["observes replaced methods and original extra arity", "method"],
		["observes a replaced Date namespace", "global"],
		["observes namespace method accessors", "accessor"],
		["retains a callee captured before a consumed argument", "captured"],
		["retains a callee captured before an ignored argument", "captured-extra"],
		["loads the namespace after prior argument preparation", "prepared"],
		["preserves original argument throws", "argument-throw"],
		["retains unknown-input conversion effects", "unknown"],
		["throws normally for Symbol and BigInt inputs", "throws"],
		["retains a shadowing namespace parameter", "shadow"],
		["retains a lexical Date namespace", "lexical"],
	])("%s", (_behavior, mode) => {
		const env = { REALM_UTC_CASE: mode };
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of [pair.compiled, pair.interpreted])
			for (const stress of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env: { ...env, ...stress } })).toBe(expected);
	});
	it("uses an owned foreign realm's UTC arithmetic and restores the caller realm", () => {
		for (const binary of [owned.compiled, owned.interpreted]) {
			const invocation = resolveHarnessExecutionInvocation(binary);
			expect(
				execFileSync(invocation.executable, invocation.args, {
					env: { ...process.env, ...STRESS_ENV, MAL_PERF_STATS: "1" },
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 60000,
				}),
			).toBe("realm-namespace-boundaries PASS\n");
		}
	});
});
