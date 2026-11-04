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
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/promise-all-dense.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-promise-all-dense-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function expected(scenario: string): string {
	return execFileSync(process.execPath, [fixture], {
		encoding: "utf8",
		env: { ...process.env, PROMISE_ALL_CASE: scenario },
	});
}

describe("typed intrinsic Promise.all aggregation", () => {
	let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let mutable: ReturnType<typeof buildBackendPairFromOneProgramImage>;
	let realm: string;
	beforeAll(() => {
		const shared = {
			fixture,
			outDir,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
		};
		pair = buildBackendPairFromOneProgramImage({
			...shared,
			name: "promise-all-dense",
			config: resolveBuildConfig({ surface: { node: true } }),
		});
		mutable = buildBackendPairFromOneProgramImage({
			...shared,
			name: "promise-all-dense-mutable",
			config: resolveBuildConfig({
				engine: { primordials: "mutable" },
				surface: { node: true },
			}),
		});
		realm = buildNativeBinary({
			fixture: "tests/local/promise-all-dense-realm.js",
			name: "promise-all-dense-realm",
			mainFile: "runtime/test262_main.c",
			outDir,
			environment: shared.environment,
			config: resolveBuildConfig({
				engine: { primordials: "locked", eval: false, realms: true },
			}),
		});
	});
	it.each([
		["settled", "returns own result elements in source order"],
		["pending", "preserves source order after out-of-order fulfillment"],
		["duplicates", "settles each occurrence of a repeated input"],
		["changedInput", "keeps captured inputs after the source Array changes"],
		["context", "preserves registration context across external settlement"],
		["ordering", "keeps element jobs in their original FIFO positions"],
		["empty", "fulfills an empty aggregation without another job"],
		["rejection", "rejects with the first queued rejection"],
		["retained", "retains fulfilled objects while another input is pending"],
		["specialValues", "preserves Number, BigInt and Symbol values"],
		["holes", "reads sparse input elements through the ordinary iterator"],
		["accessorIndex", "observes indexed getters and their mutations"],
		["observedThen", "reads an input's custom then property once"],
		["observedConstructor", "preserves input constructor observations"],
		["customIterator", "uses an own iterator instead of dense elements"],
		["iteratorClose", "closes a custom iterator after a then lookup throws"],
		["subclass", "observes an input subclass species"],
		["customResult", "preserves a subclass result capability"],
	])("%s: %s", (scenario) => {
		const oracle = expected(scenario);
		for (const binary of [pair.compiled, pair.interpreted])
			expect(runToStdout(binary, { env: { PROMISE_ALL_CASE: scenario } })).toBe(oracle);
	});
	it.each(["pending", "retained", "rejection", "changedInput", "context"])(
		"keeps %s state reachable through collection",
		(scenario) => {
			const oracle = expected(scenario);
			for (const binary of [pair.compiled, pair.interpreted])
				expect(
					runToStdout(binary, { env: { ...STRESS_ENV, PROMISE_ALL_CASE: scenario } }),
				).toBe(oracle);
		},
	);
	it("queues one typed job per admitted input occurrence", () => {
		const run = spawnSync(pair.compiled, [], {
			encoding: "utf8",
			env: { ...process.env, MAL_PERF_STATS: "1", PROMISE_ALL_CASE: "duplicates" },
		});
		expect(run.status, run.stderr).toBe(0);
		const result = JSON.parse(run.stdout) as { inputCount: number };
		expect(
			Number(run.stderr.match(/all_typed_admissions=(\d+)/)?.[1] ?? 0),
		).toBeGreaterThan(0);
		expect(Number(run.stderr.match(/all_typed_jobs=(\d+)/)?.[1] ?? 0)).toBe(
			result.inputCount,
		);
	});
	it("handles rejected inputs without reporting them as unhandled", () => {
		for (const binary of [pair.compiled, pair.interpreted]) {
			const invocation = resolveHarnessExecutionInvocation(binary);
			const run = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				env: { ...process.env, PROMISE_ALL_CASE: "rejection" },
			});
			if (run.error !== undefined) throw run.error;
			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout).toBe(expected("rejection"));
			expect(run.stderr).not.toContain("Uncaught (in promise)");
		}
	});
	it("uses the builtin's realm for result Arrays across direct and generic paths", () => {
		expect(runToStdout(realm, { env: { ...STRESS_ENV, MAL_TEST262: "1" } }).trim()).toBe(
			"promise-all-dense-realm PASS",
		);
	});
	it.each(["lateThen", "resolveOverride"])(
		"preserves mutable %s observations",
		(scenario) => {
			const oracle = expected(scenario);
			for (const binary of [mutable.compiled, mutable.interpreted])
				expect(runToStdout(binary, { env: { PROMISE_ALL_CASE: scenario } })).toBe(oracle);
		},
	);
});
