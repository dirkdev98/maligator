import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
	scaledNativeRunTimeoutMs,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/array-from-branch-columns.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-array-branch-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
let precise: string;
beforeAll(() => {
	const config = resolveBuildConfig({
		engine: {
			primordials: "mutable",
			eval: false,
			realms: false,
			regexp: false,
			intl: { enabled: false },
			temporal: false,
		},
		surface: { node: true, webPlatform: false },
	});
	const common = {
		fixture,
		outDir,
		config,
		environment: { ...process.env, MAL_PERF_STATS: "1" },
	};
	pair = buildBackendPairFromOneProgramImage({ ...common, name: "array-branch" });
	precise = buildNativeBinary({
		...common,
		name: "array-branch-precise",
		nativeStackRoots: "precise",
	});
});
function expected(scenario: string): string {
	return execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, ARRAY_BRANCH_CASE: scenario },
	});
}
function run(binary: string, scenario: string, stress = false) {
	const invocation = resolveHarnessExecutionInvocation(binary);
	const environment = {
		ARRAY_BRANCH_CASE: scenario,
		MAL_PERF_STATS: "1",
		...(stress ? STRESS_ENV : {}),
	};
	const result = spawnSync(invocation.executable, invocation.args, {
		encoding: "utf8",
		env: { ...process.env, ...environment },
		timeout: scaledNativeRunTimeoutMs(15000, environment),
	});
	expect(result.status, result.stderr || result.signal || "no exit status").toBe(0);
	expect(result.stdout).toBe(expected(scenario));
	return Number(result.stderr.match(/record_columns_admissions=(\d+)/)?.[1] ?? 0);
}
describe("branch-selected Array.from record columns", () => {
	it.each(["left", "right", "single"])("packs the private %s producer", (scenario) => {
		for (const binary of [pair.compiled, precise])
			expect(run(binary, scenario)).toBeGreaterThan(0);
		run(pair.interpreted, scenario);
	});
	it.each([
		"global",
		"method",
		"subclass",
		"published",
		"sequential-left",
		"sequential-right",
		"external",
		"second-traversal",
		"iterator",
		"abrupt",
	])("preserves the observable %s fallback", (scenario) => {
		for (const binary of [pair.compiled, precise]) expect(run(binary, scenario)).toBe(0);
		run(pair.interpreted, scenario);
	});
	it.each(["left", "right", "single", "method", "sequential-left"])(
		"roots %s through GC stress",
		(scenario) => {
			for (const binary of [pair.compiled, pair.interpreted, precise])
				run(binary, scenario, true);
		},
	);
});
