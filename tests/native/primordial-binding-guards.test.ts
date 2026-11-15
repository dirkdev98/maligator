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

	describe.each([false, true])("rebound by compiled code with realms=%s", (realms) => {
		let pair: BackendPairResult;
		beforeAll(() => {
			pair = build(
				"guards-writers",
				fixture,
				resolveBuildConfig({
					engine: { primordials: "mutable", realms },
					surface: { node: true },
				}),
			);
		});
		for (const mode of writerCases)
			it(`observes the ${mode} case like Node`, () =>
				expectNodeParity(pair, fixture, mode));
	});

	describe.each([false, true])("rebound by run-time code with realms=%s", (realms) => {
		let pair: BackendPairResult;
		beforeAll(() => {
			pair = build(
				"guards-runtime-code",
				evalFixture,
				resolveBuildConfig({
					engine: { primordials: "mutable", eval: true, realms },
					surface: { node: true },
				}),
			);
		});
		for (const mode of runtimeCodeCases)
			it(`observes the ${mode} case like Node`, () =>
				expectNodeParity(pair, evalFixture, mode));
	});
});

describe("pure namespace calls in the executing realm", () => {
	let pair: BackendPairResult;
	let boundaries: BackendPairResult;
	const pilot = "tests/local/realm-namespace-pilot.mjs";
	beforeAll(() => {
		pair = build(
			"realm-namespace-pilot",
			pilot,
			resolveBuildConfig({
				engine: { primordials: "mutable", realms: true },
				surface: { node: true },
			}),
			true,
		);
		boundaries = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/realm-namespace-boundaries.js",
			entryGoal: "script",
			entryStrict: false,
			mainFile: "tests/fixtures/realm-namespace-boundaries/main.c",
			name: "realm-namespace-boundaries",
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
			config: resolveBuildConfig({
				engine: { primordials: "mutable", realms: true, eval: false },
			}),
		});
	});
	it.each([
		"intact",
		"object",
		"mathReentry",
		"numberReentry",
		"extraArgument",
		"globalMath",
		"globalNumber",
		"method",
		"lexical",
		"shadow",
		"throw",
	])("preserves %s observations", (scenario) => {
		const env = { REALM_NAMESPACE_CASE: scenario };
		const expected = execFileSync(process.execPath, [pilot], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary, { env })).toBe(expected);
			expect(runToStdout(binary, { env: { ...STRESS_ENV, ...env } })).toBe(expected);
		}
	});
	it("admits pure calls while the current realm's namespaces are intact", () => {
		const invocation = resolveHarnessExecutionInvocation(pair.compiled);
		const result = spawnSync(invocation.executable, invocation.args, {
			encoding: "utf8",
			env: { ...process.env, MAL_PERF_STATS: "1", REALM_NAMESPACE_CASE: "intact" },
		});
		if (result.error) throw result.error;
		expect(result.status, result.stderr).toBe(0);
		const measured = JSON.parse(result.stdout) as { rounds: number };
		expect(counter(result.stderr, "admissions")).toBeGreaterThanOrEqual(measured.rounds);
		expect(counter(result.stderr, "rejections")).toBe(0);
	});
	it("uses owned foreign namespaces and their error prototypes after mutation", () => {
		for (const binary of [boundaries.compiled, boundaries.interpreted])
			expect(runToStdout(binary, { env: { ...STRESS_ENV, MAL_PERF_STATS: "1" } })).toBe(
				"realm-namespace-boundaries PASS\n",
			);
	});
});
