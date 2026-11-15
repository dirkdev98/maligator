import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	resolveHarnessExecutionInvocation,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
const fixture = "tests/local/promise-dense-combinators.mjs";
const outDir = mkdtempSync(join(tmpdir(), "mal-promise-dense-combinators-"));
let pair: ReturnType<typeof buildBackendPairFromOneProgramImage>;
afterAll(() => rmSync(outDir, { recursive: true, force: true }));
beforeAll(() => {
	pair = buildBackendPairFromOneProgramImage({
		fixture,
		name: "promise-dense-combinators",
		outDir,
		environment: { ...process.env, MAL_PERF_STATS: "1" },
		config: resolveBuildConfig({
			engine: { primordials: "mutable" },
			surface: { node: true },
		}),
	});
});
const scenarios = [
	["rejected", "retains ordered reasons when every input rejects"],
	["pendingDuplicates", "registers every repeated pending input occurrence"],
	["settled", "preserves each method's fulfillment and rejection behavior"],
	["pending", "preserves out-of-order settlement"],
	["duplicates", "registers every repeated input occurrence"],
	["empty", "preserves empty input settlement"],
	["ordering", "retains FIFO positions against adjacent reactions"],
	["retained", "retains values across pending input settlement"],
	["changedInput", "uses captured inputs after source mutation"],
	["holes", "visits holes through the ordinary iterator"],
	["accessor", "observes indexed getters and their mutations"],
	["ownIterator", "observes an own iterator"],
	["observedConstructor", "observes an input constructor getter"],
	["replacedResolve", "observes a replacement Promise.resolve"],
	["lateThen", "latches the winner before delayed thenable assimilation"],
	["lateArrayThen", "observes then added to the result Array's prototype"],
	["subclass", "preserves a custom result constructor"],
] as const;
for (const method of ["race", "allSettled", "any"]) {
	it.each(scenarios)(`${method} %s: %s`, (scenario) => {
		const env = { DENSE_COMBINATOR_METHOD: method, DENSE_COMBINATOR_CASE: scenario };
		const expected = execFileSync(process.execPath, [fixture], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
		for (const binary of [pair.compiled, pair.interpreted]) {
			expect(runToStdout(binary, { env })).toBe(expected);
			if (
				[
					"pending",
					"pendingDuplicates",
					"retained",
					"lateThen",
					"lateArrayThen",
				].includes(scenario)
			)
				expect(runToStdout(binary, { env: { ...STRESS_ENV, ...env } })).toBe(expected);
		}
	});
	it(`${method} queues every typed occurrence and handles losing rejections`, () => {
		const invocation = resolveHarnessExecutionInvocation(pair.compiled);
		const run = spawnSync(invocation.executable, invocation.args, {
			encoding: "utf8",
			env: {
				...process.env,
				MAL_PERF_STATS: "1",
				DENSE_COMBINATOR_METHOD: method,
				DENSE_COMBINATOR_CASE: "settled",
			},
		});
		if (run.error) throw run.error;
		expect(run.status, run.stderr).toBe(0);
		expect(run.stderr).not.toContain("Uncaught (in promise)");
		expect(
			Number(run.stderr.match(/combinator_typed_admissions=(\d+)/)?.[1] ?? 0),
		).toBeGreaterThan(0);
		expect(Number(run.stderr.match(/combinator_typed_jobs=(\d+)/)?.[1] ?? 0)).toBe(3);
	});
}
