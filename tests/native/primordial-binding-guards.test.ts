import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import type { ResolvedBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	resolveHarnessExecutionInvocation,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import type { BackendPairResult } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-primordial-binding-guards-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const fixture = "tests/local/primordial-binding-guards.mjs";
const evalFixture = "tests/local/primordial-binding-guards-eval.mjs";

const writerCases = [
	"intact",
	"same-value",
	"assign-namespace",
	"assign-method",
	"assign-function",
	"assign-construct",
	"define-namespace",
	"define-accessor",
	"delete-namespace",
	"delete-method",
	"reflect-set",
	"reflect-define",
	"object-assign",
	"object-keys",
	"mid-loop",
	"mid-loop-method",
] as const;

const runtimeCodeCases = [
	"eval-let",
	"eval-var",
	"eval-function",
	"sloppy-assign",
	"with-statement",
	"script-let",
] as const;

function expectedOutput(file: string, mode: string): string {
	return execFileSync(process.execPath, [file], {
		encoding: "utf8",
		env: { ...process.env, PRIMORDIAL_BINDING_CASE: mode },
	});
}

function expectNodeParity(pair: BackendPairResult, file: string, mode: string): void {
	const expected = expectedOutput(file, mode);
	for (const binary of [pair.compiled, pair.interpreted]) {
		const env = { PRIMORDIAL_BINDING_CASE: mode };
		expect(runToStdout(binary, { env })).toBe(expected);
		expect(runToStdout(binary, { env: { ...env, ...STRESS_ENV } })).toBe(expected);
	}
}

function build(name: string, file: string, config: ResolvedBuildConfig, perf = false) {
	return buildBackendPairFromOneProgramImage({
		fixture: file,
		name,
		outDir,
		config,
		...(config.surface.node ? { mainFile: HOST_MAIN } : {}),
		...(perf ? { environment: { ...process.env, MAL_PERF_STATS: "1" } } : {}),
	});
}

const counter = (stderr: string, name: string) =>
	Number(
		stderr.match(
			new RegExp(`\\[perf-primordial-binding-guards\\] .*\\b${name}=(\\d+)`),
		)?.[1],
	);

describe("global primordial calls behind the primordial-bindings guard", () => {
	describe("with untouched bindings", () => {
		let mutable: BackendPairResult;
		let locked: BackendPairResult;
		beforeAll(() => {
			mutable = build(
				"guards-mutable",
				fixture,
				resolveBuildConfig({ engine: { primordials: "mutable" } }),
				true,
			);
			locked = build("guards-locked", fixture, resolveBuildConfig({}));
		});

		it("matches Node with mutable and locked primordials", () => {
			expectNodeParity(mutable, fixture, "intact");
			expectNodeParity(locked, fixture, "intact");
		});

		it("selects the known operations at every guard", () => {
			const invocation = resolveHarnessExecutionInvocation(mutable.compiled);
			const result = spawnSync(invocation.executable, invocation.args, {
				env: { ...process.env, MAL_PERF_STATS: "1" },
				encoding: "utf8",
			});
			expect(result.status, result.stderr || result.stdout).toBe(0);
			expect(result.stdout).toBe(expectedOutput(fixture, "intact"));
			// Each of the two warm loops samples 64 rounds through several guarded runs.
			expect(counter(result.stderr, "admissions")).toBeGreaterThanOrEqual(2 * 64);
			expect(counter(result.stderr, "rejections")).toBe(0);
		});
	});

	describe("rebound by compiled code", () => {
		let pair: BackendPairResult;
		beforeAll(() => {
			pair = build(
				"guards-writers",
				fixture,
				resolveBuildConfig({
					engine: { primordials: "mutable" },
					surface: { node: true },
				}),
			);
		});
		for (const mode of writerCases)
			it(`observes the ${mode} case like Node`, () =>
				expectNodeParity(pair, fixture, mode));
	});

	describe("rebound by code compiled at run time", () => {
		let pair: BackendPairResult;
		beforeAll(() => {
			pair = build(
				"guards-runtime-code",
				evalFixture,
				resolveBuildConfig({
					engine: { primordials: "mutable", eval: true },
					surface: { node: true },
				}),
			);
		});
		for (const mode of runtimeCodeCases)
			it(`observes the ${mode} case like Node`, () =>
				expectNodeParity(pair, evalFixture, mode));
	});
});
