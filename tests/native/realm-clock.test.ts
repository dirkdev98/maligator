import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import type { BackendPairResult } from "../../src/test-harness.ts";

const outDir = mkdtempSync(join(tmpdir(), "mal-realm-clock-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
const fixture = "tests/local/realm-clock.mjs";
let pair: BackendPairResult;
let owned: BackendPairResult;
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "realm-clock",
		outDir,
		mainFile: HOST_MAIN,
		config: resolveBuildConfig({
			engine: { primordials: "mutable", realms: true, eval: false },
			surface: { node: true },
		}),
	});
	const fn = pair.programImage.native.functions.find(
		(fn) =>
			String.fromCharCode(
				...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
			) === "clock",
	)!;
	expect(
		fn.body.instructions.some(
			(op) => op.opcode === "CALL_KNOWN" && op.operation === "Date.now",
		),
	).toBe(true);
	owned = buildBackendPairFromOneProgramImage({
		fixture: "tests/local/realm-namespace-boundaries.js",
		name: "realm-clock-owned",
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
describe("clock reads in the executing realm", () => {
	it.each([
		["returns current timestamps from intact namespaces", "intact"],
		["ignores argument values without coercing them", "ignored-value"],
		["observes replaced methods and every repeated call", "method"],
		["observes a replaced global namespace", "global"],
		["observes a method accessor", "accessor"],
		["retains the captured callee across argument mutation", "captured"],
		["propagates argument throws before calling the clock", "argument-throw"],
		["retains a shadowing parameter", "shadow"],
		["retains a lexical namespace", "lexical"],
	])("%s", (_behavior, mode) => {
		const env = { REALM_CLOCK_CASE: mode };
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of [pair.compiled, pair.interpreted])
			for (const stress of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env: { ...env, ...stress } })).toBe(expected);
	});
	it("uses an owned foreign realm's clock and restores the caller realm", () => {
		for (const binary of [owned.compiled, owned.interpreted])
			expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_PERF_STATS: "1" } })).toBe(
				"realm-namespace-boundaries PASS\n",
			);
	});
});
